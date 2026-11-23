/**
 * Narrow Electron control surface for an external local agent. This deliberately
 * projects captions and diagnostic facts instead of exposing stores, provider
 * frames, credentials, or arbitrary app state.
 */
import type { AppSession } from './session';
import type { Leg, Segment } from '../lib/conversation/types';
import useAudioStore from '../stores/audioStore';
import { useProviderStore } from '../stores/providerStore';
import { useRoutingStore } from '../stores/routingStore';
import { useSettingsStore } from '../stores/settingsStore';
import useLogStore from '../stores/logStore';
import { presentProviders } from '../providers/registry';

type ElectronBridge = Pick<Window['electron'], 'invoke' | 'receive' | 'removeListener'>;
type Command = 'status' | 'session.start' | 'session.stop' | 'logs.enable' | 'logs.list' | 'captions.list' | 'provider.configure-qwen-beijing' | 'credentials.status' | 'notes.check';
type Request = { id: string; command: Command; args?: unknown };
type Reply = { id: string; result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } } };

const LOG_EVENTS = new Set([
  'caption.translation.request',
  'caption.translation.response',
  'caption.translation.completed',
  'caption.translation.failed',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedLimit(value: unknown, fallback = 20): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.floor(value)))
    : fallback;
}

function requestOf(value: unknown): Request | null {
  if (!isObject(value) || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128) return null;
  const command = value.command;
  if (command !== 'status' && command !== 'session.start' && command !== 'session.stop'
    && command !== 'logs.enable' && command !== 'logs.list' && command !== 'captions.list'
    && command !== 'provider.configure-qwen-beijing' && command !== 'credentials.status' && command !== 'notes.check') return null;
  return { id: value.id, command, args: value.args };
}

function textField(text: string, includeText: boolean): { text?: string; truncated?: boolean } {
  if (!includeText) return {};
  return text.length > 2_000 ? { text: text.slice(0, 2_000), truncated: true } : { text };
}

function captionsOf(legs: readonly Leg[], limit: number, includeText: boolean): unknown[] {
  const leg = legs.find((item) => item.leg === 'participant');
  if (!leg) return [];
  const groups = new Map<string, { origin: string; openedAt: number; source?: Segment; translation?: Segment }>();
  for (const segment of leg.segments) {
    if (segment.side !== 'source' && segment.side !== 'translation') continue;
    const origin = segment.origin ?? segment.id;
    const group = groups.get(origin) ?? { origin, openedAt: segment.openedAt };
    group.openedAt = Math.min(group.openedAt, segment.openedAt);
    if (segment.side === 'source') group.source = segment;
    else group.translation = segment;
    groups.set(origin, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, limit)
    .map((group) => ({
      origin: group.origin,
      openedAt: group.openedAt,
      ...(group.source ? { source: {
        ...textField(group.source.text, includeText),
        language: group.source.language ?? null,
        final: group.source.final,
      } } : {}),
      ...(group.translation ? { translation: {
        ...textField(group.translation.text, includeText),
        language: group.translation.language ?? null,
        final: group.translation.final,
      } } : {}),
    }));
}

function safeLogData(type: string, raw: unknown): Record<string, unknown> {
  const source = isObject(raw) ? raw : {};
  const safe: Record<string, unknown> = {};
  for (const key of ['request', 'elapsedMs', 'status', 'processingMs', 'kind', 'sourceLanguage', 'model', 'deadlineMs']) {
    const value = source[key];
    if (typeof value === 'string' && value.length <= 80) safe[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
  }
  return { type, data: safe };
}

function logsOf(limit: number): unknown[] {
  const logs = useLogStore.getState().allLogs;
  const result: unknown[] = [];
  for (let i = logs.length - 1; i >= 0 && result.length < limit; i -= 1) {
    const entry = logs[i];
    if (!entry.events?.some((event) => LOG_EVENTS.has(event.type))) continue;
    result.push({
      timestamp: entry.timestamp,
      ...(entry.clientId ? { leg: entry.clientId } : {}),
      events: entry.events.filter((event) => LOG_EVENTS.has(event.type)).map((event) => safeLogData(event.type, event.data)),
    });
  }
  return result;
}

export function attachAgentControl(
  session: AppSession,
  electron: ElectronBridge | undefined = typeof window === 'undefined' ? undefined : window.electron,
): () => void {
  if (!electron?.receive || !electron.removeListener || !electron.invoke) return () => {};

  const status = () => {
    const providers = useProviderStore.getState();
    const selected = providers.selected;
    const readiness = selected ? providers.readiness[selected] : undefined;
    const audioMode = useAudioStore.getState().mode;
    const subtitle = session.subtitle.get();
    const settingsLoaded = useSettingsStore.getState().settingsLoaded;
    const providerLoaded = !!(selected && providers.entries[selected]);
    const incomingOnly = audioMode === 'participant';
    const speechOutputOff = useRoutingStore.getState().participantSpeech !== true;
    const canStart = subtitle.canStart && incomingOnly && speechOutputOff;
    let reasonCode: string | undefined;
    if (!settingsLoaded || !providerLoaded) reasonCode = 'app_not_ready';
    else if (!incomingOnly) reasonCode = 'participant_audio_mode_required';
    else if (!speechOutputOff) reasonCode = 'translated_speech_output_enabled';
    else if (!subtitle.canStart) reasonCode = subtitle.idle.kind === 'unready'
      ? (subtitle.idle.code ?? 'provider_unready')
      : subtitle.idle.kind === 'failed' ? subtitle.idle.notice.code : 'session_not_startable';
    return {
      appReady: settingsLoaded && providerLoaded,
      phase: subtitle.phase,
      canStart,
      provider: selected,
      audioMode,
      incomingOnly,
      translatedSpeechOutputEnabled: !speechOutputOff,
      readiness: readiness?.state ?? 'unknown',
      ...(reasonCode ? { reasonCode } : {}),
      diagnosticLogsEnabled: useLogStore.getState().enabled,
    };
  };

  const reply = (id: string, result: Reply['result']) => {
    void electron.invoke('agent-control:response', { id, result }).catch(() => {});
  };

  const receive = (value: unknown) => {
    const request = requestOf(value);
    if (!request) {
      if (isObject(value) && typeof value.id === 'string' && value.id.length <= 128) {
        reply(value.id, { ok: false, error: { code: 'invalid_request', message: 'Invalid agent-control request.' } });
      }
      return;
    }
    void (async () => {
      try {
        switch (request.command) {
          case 'status':
            reply(request.id, { ok: true, data: status() });
            return;
          case 'session.start': {
            if (session.runner.state.getState().phase !== 'idle') {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before starting a new one.' } });
              return;
            }
            if (!status().appReady) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app has not finished loading its session settings.' } });
              return;
            }
            // This control surface owns an explicitly incoming-only profile. Use the
            // same persisted actions as the audio settings, before readiness is read.
            useAudioStore.getState().setMode('participant');
            useRoutingStore.getState().setParticipantSpeech(false);
            await waitForProviderCheck();
            const state = status();
            if (!state.appReady) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app has not finished loading its session settings.' } });
              return;
            }
            if (!state.canStart) {
              reply(request.id, { ok: false, error: { code: state.reasonCode ?? 'session_not_startable', message: 'The incoming-only session is not ready to start.' } });
              return;
            }
            await session.start();
            reply(request.id, { ok: true, data: status() });
            return;
          }
          case 'session.stop':
            await session.runner.stop();
            reply(request.id, { ok: true, data: status() });
            return;
          case 'logs.enable': {
            if (!useSettingsStore.getState().settingsLoaded) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app settings are not ready yet.' } });
              return;
            }
            await useSettingsStore.getState().setDiagnosticLogs(true);
            if (!useLogStore.getState().enabled) {
              reply(request.id, { ok: false, error: { code: 'diagnostic_logs_enable_failed', message: 'Diagnostic logging could not be enabled.' } });
              return;
            }
            reply(request.id, { ok: true, data: { enabled: true } });
            return;
          }
          case 'logs.list': {
            const limit = isObject(request.args) ? boundedLimit(request.args.limit) : 20;
            reply(request.id, { ok: true, data: { enabled: useLogStore.getState().enabled, events: logsOf(limit) } });
            return;
          }
          case 'captions.list': {
            const args = isObject(request.args) ? request.args : {};
            const limit = boundedLimit(args.limit, 20);
            const includeText = args.includeText === true;
            const items = captionsOf(session.runner.conversation.snapshot(), limit, includeText);
            reply(request.id, { ok: true, data: { textIncluded: includeText, items } });
            return;
          }
          case 'credentials.status': {
            if (request.args !== undefined && (!isObject(request.args) || Object.keys(request.args).length !== 0)) {
              reply(request.id, { ok: false, error: { code: 'invalid_argument', message: 'This command takes no arguments.' } });
              return;
            }
            if (!useSettingsStore.getState().settingsLoaded) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app settings are not ready yet.' } });
              return;
            }
            const providers = presentProviders();
            const openai = providers.find((item) => item.id === 'openai');
            const qwen = providers.find((item) => item.id === 'qwen_livetranslate');
            const store = useProviderStore.getState();
            await Promise.all([openai && store.load(openai), qwen && store.load(qwen)]);
            const entries = useProviderStore.getState().entries;
            reply(request.id, { ok: true, data: {
              openaiConfigured: Boolean(entries.openai?.credentials.apiKey?.trim()),
              qwenConfigured: Boolean(entries.qwen_livetranslate?.credentials.apiKey?.trim()),
            } });
            return;
          }
          case 'notes.check': {
            if (!isObject(request.args) || (request.args.service !== 'bailian_notes' && request.args.service !== 'compatible_notes')) {
              reply(request.id, { ok: false, error: { code: 'invalid_argument', message: 'Choose Bailian or compatible notes.' } });
              return;
            }
            const [{ notesChatForService }, { writeNotes }] = await Promise.all([
              import('../lib/notes/appNotes'), import('../lib/notes/write'),
            ]);
            const service = request.args.service;
            const configured = await notesChatForService(service);
            if (!configured) {
              reply(request.id, { ok: false, error: { code: 'notes_not_configured', message: 'The selected notes service is not configured.' } });
              return;
            }
            const samples = [
              ['en', 'Decision: ship version 2 after verifying HDR input.'],
              ['ja', '田中さんが金曜日までに30 fpsのテスト結果を送ります。'],
              ['zh', '如果夜间测试未通过，就推迟发布。'],
            ];
            const result = await writeNotes({
              sentences: samples.map(([language, text], index) => ({
                n: index + 1,
                segmentId: null,
                side: 'other',
                sideCertain: true,
                track: 'other',
                speaker: 'Participant 1',
                speakerByUser: null,
                speakerName: null,
                startMs: index * 32_000,
                endMs: index * 32_000 + 5_000,
                text,
                language,
                timeKind: 'given',
                translation: null,
                heard: null,
              })),
              speakerLabel: (sentence) => sentence.speaker,
              language: { code: 'zh', name: 'Chinese' },
              chat: configured.chat,
              signal: AbortSignal.timeout(30_000),
            });
            if (!result.ok) {
              reply(request.id, { ok: false, error: { code: 'notes_check_failed', message: 'The service did not return usable meeting notes.' } });
              return;
            }
            reply(request.id, { ok: true, data: { service, model: configured.model, topics: result.body.topics.length } });
            return;
          }
          case 'provider.configure-qwen-beijing': {
            if (session.runner.state.getState().phase !== 'idle' || useProviderStore.getState().selectionLocked) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before changing providers.' } });
              return;
            }
            if (!useSettingsStore.getState().settingsLoaded) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app settings are not ready yet.' } });
              return;
            }
            if (!isObject(request.args) || Object.keys(request.args).some((key) => key !== 'apiKey')
              || typeof request.args.apiKey !== 'string' || request.args.apiKey.trim().length === 0
              || request.args.apiKey.length > 4_096) {
              reply(request.id, { ok: false, error: { code: 'invalid_argument', message: 'Expected one nonempty apiKey value.' } });
              return;
            }
            const provider = presentProviders().find((item) => item.id === 'qwen_livetranslate');
            if (!provider) {
              reply(request.id, { ok: false, error: { code: 'provider_unavailable', message: 'Qwen LiveTranslate is not available in this build.' } });
              return;
            }
            const store = useProviderStore.getState();
            await store.load(provider);
            if (session.runner.state.getState().phase !== 'idle' || useProviderStore.getState().selectionLocked) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before changing providers.' } });
              return;
            }
            // This is the own-key Beijing connection choice. `region` stays
            // reserved for managed Qwen billing and is intentionally untouched.
            store.updateSettings(provider, { connection: 'bailian-cn' });
            store.setCredential(provider, 'apiKey', request.args.apiKey.trim());
            const fields = ['apiKey', 'connection'];
            if (!await store.flush(provider, fields)) {
              reply(request.id, { ok: false, error: { code: 'provider_configuration_persist_failed', message: 'The Qwen configuration could not be saved.' } });
              return;
            }
            reply(request.id, { ok: true, data: {
              provider: 'qwen_livetranslate', configured: true,
              connection: 'bailian-cn',
              sessionStarted: false, credentialConfigured: true,
            } });
            return;
          }
        }
      } catch {
        reply(request.id, { ok: false, error: { code: 'control_request_failed', message: 'The agent-control request failed.' } });
      }
    })();
  };

  electron.receive('agent-control:request', receive);
  void electron.invoke('agent-control:ready').catch(() => {});
  return () => electron.removeListener('agent-control:request', receive);
}

/** Wait for the current provider's readiness refresh after the settings above change. */
function waitForProviderCheck(timeoutMs = 15_000): Promise<void> {
  const checking = () => {
    const { selected, readiness } = useProviderStore.getState();
    return !!selected && readiness[selected]?.state === 'checking';
  };
  if (!checking()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
    unsubscribe = useProviderStore.subscribe(() => {
      if (!checking()) finish();
    });
  });
}
