/**
 * Narrow Electron control surface for an external local agent. This deliberately
 * projects captions and diagnostic facts instead of exposing stores, provider
 * frames, credentials, or arbitrary app state.
 */
import type { AppSession } from './session';
import type { Leg, Segment } from '../lib/conversation/types';
import { planFromStores, subscribePlan } from '../lib/plan/fromStores';
import { providersIn, transcriptionProvider, unitFor } from '../lib/plan/read';
import { BAILIAN_NOTES, notesServiceOf } from '../lib/notes/notesService';
import useAudioStore from '../stores/audioStore';
import { useLineUpStore } from '../stores/lineUpStore';
import { ensureFaceToFaceSettings, useFaceToFaceStore } from '../stores/faceToFaceStore';
import { faceToFaceLanguageOptions, faceToFaceProviderFor, faceToFaceTargets, resolveFaceToFaceLanguages } from '../lib/faceToFace/route';
import { useProviderStore } from '../stores/providerStore';
import { useRoutingStore } from '../stores/routingStore';
import { useSettingsStore } from '../stores/settingsStore';
import useLogStore from '../stores/logStore';
import { presentProviders } from '../providers/registry';
import { BAILIAN_ENDPOINT_ID, BAILIAN_WORKSPACE_CONNECTION, normalizeBailianWorkspaceId } from '../providers/qwen_livetranslate/endpoints';
import { QWEN_MODEL, type QwenSettings } from '../providers/qwen_livetranslate/settings';
import { isLoopbackInput, isVirtualMic, isVirtualSpeaker } from '../utils/audioDevices';
import { getEnvironment } from '../utils/environment';
import { getAppVersion } from '../utils/conversationExport';
import { createAppRouting } from '../lib/audio/appAudio';
import { systemAudioSettings } from '../lib/audio/appCapture';
import { routesFor } from '../lib/audio/routes';
import { openSystemAudio } from '../lib/audio/capture/systemAudio';
import { getOutputFormFactor } from '../lib/audio/formFactor';
import { createLevelMeter } from '../lib/audio/levelMeter';
import { base64ToPcm } from '../lib/contract/pcm64';
import { SAMPLE_RATE } from '../lib/contract/adapter';
import type { OpenSource } from '../lib/session/source';
import { loadQwenVoiceProfiles } from '../providers/qwen_livetranslate/voiceProfileStorage';
import { runQwenVoiceBenchmark } from '../providers/qwen_livetranslate/voiceBenchmark';
import { getFaceToFaceDiagnostics, startFaceToFaceRuntime, stopFaceToFaceRuntime } from '../lib/faceToFace/runtime';
import { billingMonth, remainingQuota, useUsageStore } from '../lib/usage/ledger';
import { useSessionTokenStore } from '../lib/usage/sessionTokens';

type ElectronBridge = Pick<Window['electron'], 'invoke' | 'receive' | 'removeListener'>;
type Command = 'status' | 'view.set-mode' | 'audio.inputs' | 'audio.system-check' | 'session.start' | 'session.stop' | 'logs.enable' | 'logs.list' | 'captions.list'
  | 'provider.configure-qwen-beijing' | 'provider.configure-qwen-workspace' | 'provider.configure-qwen-defaults' | 'credentials.status' | 'notes.check'
  | 'voice.benchmark' | 'face-to-face.start' | 'face-to-face.stop' | 'face-to-face.replay' | 'usage.summary';
type Request = { id: string; command: Command; args?: unknown };
type Reply = { id: string; result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } } };

const AUDIO_LOG_FIELDS: Record<string, readonly string[]> = {
  'audio.echo.warning': ['cause', 'lagMs', 'rho'],
  'audio.capture.mic': ['requested', 'applied'],
  'audio.capture.participant': ['backend'],
};

const STREAM_LOG_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'response.text.delta',
  'response.audio_transcript.delta',
]);

const LOG_EVENTS = new Set([
  'caption.translation.request',
  'caption.translation.response',
  'caption.translation.completed',
  'caption.translation.failed',
  ...Object.keys(AUDIO_LOG_FIELDS),
  ...STREAM_LOG_EVENTS,
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
  if (command !== 'status' && command !== 'view.set-mode' && command !== 'audio.inputs' && command !== 'audio.system-check' && command !== 'session.start' && command !== 'session.stop'
    && command !== 'logs.enable' && command !== 'logs.list' && command !== 'captions.list'
    && command !== 'provider.configure-qwen-beijing' && command !== 'provider.configure-qwen-workspace'
    && command !== 'provider.configure-qwen-defaults' && command !== 'credentials.status' && command !== 'notes.check'
    && command !== 'voice.benchmark' && command !== 'face-to-face.start' && command !== 'face-to-face.stop' && command !== 'face-to-face.replay'
    && command !== 'usage.summary') return null;
  return { id: value.id, command, args: value.args };
}

function replaySource(pcm: Int16Array): OpenSource {
  return async (_leg, signal) => {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => clearTimeout(timer);
    return {
      onPcm(listener) {
        const started = performance.now();
        let offset = 0;
        const next = () => {
          if (signal.aborted) return;
          const end = Math.min(pcm.length, offset + SAMPLE_RATE * 0.08);
          listener(pcm.subarray(offset, end));
          offset = end;
          if (offset < pcm.length) timer = setTimeout(next, Math.max(0, started + offset / SAMPLE_RATE * 1000 - performance.now()));
        };
        timer = setTimeout(next, 0);
        return stop;
      },
      onEnded: () => () => {},
      onDegraded: () => () => {},
      async stop() { stop(); },
    };
  };
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
  const keys = AUDIO_LOG_FIELDS[type] ?? ['request', 'elapsedMs', 'status', 'processingMs', 'kind', 'sourceLanguage', 'model', 'deadlineMs'];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length <= 80) safe[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (key === 'applied' && typeof value === 'boolean') safe[key] = value;
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
      events: entry.events.filter((event) => LOG_EVENTS.has(event.type)).map((event) => {
        if (STREAM_LOG_EVENTS.has(event.type)) {
          // Match the service's event sequence without exposing a caption, an item ID or PCM.
          return { type: event.type, data: typeof event.atMs === 'number' ? { atMs: event.atMs } : {} };
        }
        return safeLogData(event.type, event.data);
      }),
    });
  }
  return result;
}

export function attachAgentControl(
  session: AppSession,
  electron: ElectronBridge | undefined = typeof window === 'undefined' ? undefined : window.electron,
): () => void {
  if (!electron?.receive || !electron.removeListener || !electron.invoke) return () => {};
  let checkingSystemAudio = false;
  let benchmarkingVoice = false;

  const status = () => {
    const plan = planFromStores();
    const provider = plan.state === 'ready' ? transcriptionProvider(plan.plan).id : null;
    const translationProvider = plan.state === 'ready' ? unitFor(plan.plan, 'translation').provider.id : null;
    const notesService = notesServiceOf(useLineUpStore.getState().lineUp);
    const readiness = provider ? useProviderStore.getState().readiness[provider] : undefined;
    const audioMode = useAudioStore.getState().mode;
    const run = session.runner.state.getState();
    const subtitle = session.subtitle.get();
    const { mode: appMode, phase: faceToFacePhase, languages, runLanguages } = useFaceToFaceStore.getState();
    const faceToFaceLineUp = useLineUpStore.getState().lineUp;
    const faceToFaceTranslationService = faceToFaceLineUp?.translation ?? null;
    const faceToFaceProvider = faceToFaceProviderFor(faceToFaceTranslationService);
    const runningLanguages = faceToFacePhase === 'idle' || faceToFacePhase === 'error' ? null : runLanguages;
    const faceToFaceLanguages = runningLanguages ?? resolveFaceToFaceLanguages(faceToFaceTranslationService, languages);
    const faceToFaceUnavailableReason = faceToFaceLineUp === null
      ? 'lineup_pending'
      : faceToFaceProvider === null ? 'unsupported_translation_service' : null;
    const faceToFaceReadiness = faceToFaceProvider
      ? useProviderStore.getState().readiness[faceToFaceProvider] ?? { state: 'unknown' as const }
      : null;
    const { settingsLoaded, notesBailianModel } = useSettingsStore.getState();
    const qwenConnection = (useProviderStore.getState().entries.qwen_livetranslate?.settings as Partial<QwenSettings> | undefined)?.connection;
    const appReady = settingsLoaded && plan.state !== 'loading';
    const incomingOnly = audioMode === 'participant';
    const speechOutputOff = useRoutingStore.getState().participantSpeech !== true;
    const canStart = appMode === 'meeting' && appReady && plan.state === 'ready' && subtitle.canStart && incomingOnly && speechOutputOff;
    let reasonCode: string | undefined;
    if (!appReady) reasonCode = 'app_not_ready';
    else if (appMode === 'face-to-face') reasonCode = 'face_to_face_selected';
    else if (!incomingOnly) reasonCode = 'participant_audio_mode_required';
    else if (!speechOutputOff) reasonCode = 'translated_speech_output_enabled';
    else if (!subtitle.canStart) reasonCode = subtitle.idle.kind === 'unready'
      ? (subtitle.idle.code ?? 'provider_unready')
      : subtitle.idle.kind === 'failed' ? subtitle.idle.notice.code : 'session_not_startable';
    return {
      appVersion: getAppVersion(),
      appReady,
      appMode,
      faceToFacePhase,
      ...(appMode === 'face-to-face' ? {
        faceToFace: getFaceToFaceDiagnostics(), faceToFaceLanguages, faceToFaceProvider, faceToFaceTranslationService,
        faceToFaceUnavailableReason,
        faceToFaceService: { provider: faceToFaceProvider, translationService: faceToFaceTranslationService, supported: faceToFaceProvider !== null, readiness: faceToFaceReadiness },
      } : {}),
      phase: subtitle.phase,
      canStart,
      provider,
      translationProvider,
      ...(translationProvider === 'qwen_livetranslate' ? { translationModel: QWEN_MODEL } : {}),
      ...(qwenConnection ? { qwenConnection } : {}),
      notesService,
      ...(notesService === BAILIAN_NOTES ? { notesModel: notesBailianModel } : {}),
      audioMode,
      ...(run.phase === 'running' && run.outgoingTarget ? { outgoingTarget: run.outgoingTarget } : {}),
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
  const endpointSourceForLabel = async (label: string): Promise<string | undefined> => {
    const available: unknown = await electron.invoke('list-system-audio-sources');
    const matches = (Array.isArray(available) ? available : []).flatMap((item) => isObject(item)
      && typeof item.deviceId === 'string' && item.deviceId.startsWith('endpoint:')
      && typeof item.label === 'string' && item.label.slice(0, 180) === label ? [item.deviceId] : []);
    return matches.length === 1 ? matches[0] : undefined;
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
          case 'usage.summary': {
            const month = isObject(request.args) && typeof request.args.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(request.args.month)
              ? request.args.month
              : billingMonth();
            const { rows, quotas } = useUsageStore.getState();
            const tokens = useSessionTokenStore.getState();
            reply(request.id, { ok: true, data: {
              month,
              usage: rows.filter((row) => row.month === month),
              sessions: tokens.history.filter((session) => billingMonth(session.startedAt) === month).slice(0, 100),
              current: { meeting: tokens.meeting, faceToFace: tokens['face-to-face'] },
              quotaSnapshots: Object.entries(quotas).map(([model, snapshot]) => ({
                model,
                capturedAt: snapshot.capturedAt,
                reportedRemainingTokens: snapshot.remainingTokens,
                locallyEstimatedRemainingTokens: remainingQuota(rows, model, snapshot),
              })),
            } });
            return;
          }
          case 'audio.inputs': {
            const [browserDevices, available] = await Promise.all([
              navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [],
              electron.invoke('list-system-audio-sources').catch(() => null),
            ]);
            const {
              audioInputDevices, audioMonitorDevices, selectedInputDevice, selectedParticipantSource,
              participantSources, participantCaptureWidened, devicesLoaded, isMicMuted, echoCancellationMode,
            } = useAudioStore.getState();
            const candidates: unknown[] = Array.isArray(available) ? available : participantSources;
            const systemDefault = browserDevices.find((device) => device.kind === 'audioinput' && device.deviceId === 'default');
            const systemOutput = browserDevices.find((device) => device.kind === 'audiooutput' && device.deviceId === 'default');
            const routing = createAppRouting(getEnvironment()).get();
            const routes = routesFor(routing, false);
            const virtualOutput = audioMonitorDevices.find((device) => device.deviceId === routing.sinks.virtual);
            const describe = (device: { label: string; isVirtual?: boolean }) => ({
              label: device.label.slice(0, 180),
              virtual: Boolean(device.isVirtual || isVirtualMic(device) || isLoopbackInput(device)),
            });
            reply(request.id, { ok: true, data: {
              devicesLoaded,
              meetingMicMuted: isMicMuted,
              microphoneEchoMode: echoCancellationMode,
              meetingInput: selectedInputDevice ? describe(selectedInputDevice) : null,
              systemDefault: systemDefault?.label ? describe(systemDefault) : null,
              systemOutput: systemOutput?.label ? { label: systemOutput.label.slice(0, 180), virtual: isVirtualSpeaker(systemOutput) } : null,
              virtualOutput: virtualOutput ? { label: virtualOutput.label.slice(0, 180) } : null,
              participantSource: selectedParticipantSource ? {
                  scope: selectedParticipantSource.deviceId.startsWith('endpoint:') ? 'endpoint'
                    : selectedParticipantSource.deviceId.startsWith('app:') ? 'application'
                    : selectedParticipantSource.deviceId.startsWith('cable:') ? 'cable' : 'system',
                  label: selectedParticipantSource.label.slice(0, 180),
                }
                : { scope: 'system' },
              participantApplications: candidates.flatMap((candidate) => isObject(candidate)
                && typeof candidate.deviceId === 'string' && candidate.deviceId.startsWith('app:') && typeof candidate.label === 'string'
                ? [candidate.label.slice(0, 180)] : []),
              participantOutputs: candidates.flatMap((candidate) => isObject(candidate)
                && typeof candidate.deviceId === 'string' && candidate.deviceId.startsWith('endpoint:') && typeof candidate.label === 'string'
                ? [candidate.label.slice(0, 180)] : []),
              participantCaptureWidened,
              systemOutputForm: getOutputFormFactor(),
              participantPcmRuntime: session.audioIfLoaded?.()?.capture?.participantPcmRuntime?.() ?? null,
              speechRoutes: {
                outgoingToMeeting: routes.some(({ from, to }) => from === 'speaker' && to === 'virtual'),
                outgoingToLocalMonitor: routes.some(({ from, to }) => from === 'speaker' && to === 'me'),
                incomingToLocalPlayback: routes.some(({ from, to }) => from === 'participant' && to === 'them'),
              },
              inputs: audioInputDevices.map(describe),
            } });
            return;
          }
          case 'audio.system-check': {
            const { mode, phase } = useFaceToFaceStore.getState();
            if (checkingSystemAudio || mode !== 'meeting' || phase !== 'idle' || session.runner.state.getState().phase !== 'idle') {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Run this check while Online Meeting is idle.' } });
              return;
            }
            const endpointLabel = isObject(request.args) && typeof request.args.endpointLabel === 'string'
              ? request.args.endpointLabel : undefined;
            checkingSystemAudio = true;
            try {
              let selected = useAudioStore.getState().selectedParticipantSource?.deviceId ?? 'desktop-audio-loopback';
              if (endpointLabel) {
                const endpoint = await endpointSourceForLabel(endpointLabel);
                if (!endpoint) {
                  reply(request.id, { ok: false, error: { code: 'endpoint_not_found', message: 'Choose one exact, unique Windows playback source from audio inputs.' } });
                  return;
                }
                selected = endpoint;
              }
              let backend: string | undefined;
              const signal = AbortSignal.timeout(12_000);
              const level = selected.startsWith('endpoint:') ? createLevelMeter() : null;
              let peakLevel = 0;
              const source = await openSystemAudio({
                sourceId: () => selected,
                muted: () => level === null,
                subscribe: () => () => {},
                audioSeen: () => {},
                widened: () => {},
                meetingOutput: systemAudioSettings().meetingOutput,
                captureStarted: (started) => { backend = started; },
              }, signal);
              const offLevel = level ? source.onPcm((pcm) => {
                level.push(pcm);
                peakLevel = Math.max(peakLevel, level.readPeak());
              }) : undefined;
              try {
                if (level) {
                  await new Promise((resolve) => setTimeout(resolve, 750));
                }
              } finally {
                offLevel?.();
                await source.stop();
              }
              reply(request.id, { ok: true, data: { captureOpened: true, ...(backend ? { backend } : {}), ...(level ? { peakLevel } : {}) } });
            } catch (error) {
              const message = error instanceof Error ? error.message.slice(0, 300) : 'The participant audio source could not be opened.';
              reply(request.id, { ok: false, error: { code: 'system_audio_check_failed', message } });
            } finally {
              checkingSystemAudio = false;
            }
            return;
          }
          case 'voice.benchmark': {
            const args = isObject(request.args) ? request.args : {};
            if (typeof args.round !== 'number' || !Number.isInteger(args.round) || args.round < 1 || args.round > 9
              || typeof args.pcm !== 'string' || args.pcm.length > 512_000) {
              reply(request.id, { ok: false, error: { code: 'benchmark_bad_fixture', message: 'The benchmark requires a valid synthetic audio sample.' } });
              return;
            }
            if (benchmarkingVoice || session.runner.state.getState().phase !== 'idle' || useFaceToFaceStore.getState().phase !== 'idle') {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Run the voice benchmark while both meeting modes are idle.' } });
              return;
            }
            benchmarkingVoice = true;
            let stage = 'credentials';
            try {
              const entry = useProviderStore.getState().entries.qwen_livetranslate;
              const apiKey = entry?.credentials.apiKey?.trim();
              const settings = entry?.settings as QwenSettings | undefined;
              if (!apiKey || settings?.connection !== BAILIAN_ENDPOINT_ID) {
                reply(request.id, { ok: false, error: { code: 'benchmark_bailian_required', message: 'The benchmark needs the Bailian key that created the fixed voice.' } });
                return;
              }
              stage = 'voice_profiles';
              const profiles = await loadQwenVoiceProfiles(apiKey);
              const selected = profiles.find((profile) => profile.id === settings.voice);
              const fixed = selected ?? (profiles.length === 1 ? profiles[0] : undefined);
              if (!fixed && !args.firstSpeakerOnly) {
                reply(request.id, { ok: false, error: { code: 'benchmark_fixed_voice_required', message: 'Select the fixed Qwen voice you want to benchmark.' } });
                return;
              }
              stage = 'fixture';
              const pcm = base64ToPcm(args.pcm);
              if (pcm.length < 24_000 || pcm.length > 192_000) {
                reply(request.id, { ok: false, error: { code: 'benchmark_bad_fixture', message: 'Use one to eight seconds of 24 kHz mono PCM.' } });
                return;
              }
              stage = 'realtime';
              const report = await runQwenVoiceBenchmark({
                endpoint: BAILIAN_ENDPOINT_ID,
                apiKey,
                fixedVoice: fixed?.id ?? '',
                firstSpeakerOnly: args.firstSpeakerOnly === true,
                clips: [{ pcm, sampleRate: 24_000 }],
                rounds: 1,
                startRound: args.round - 1,
                targetLanguage: 'en',
                signal: AbortSignal.timeout(34_000),
              });
              reply(request.id, { ok: true, data: { ...report, ...(args.firstSpeakerOnly ? {} : { fixedVoiceSelection: selected ? 'current' : 'only-stored' }) } });
            } catch {
              reply(request.id, { ok: false, error: { code: `voice_benchmark_${stage}_failed`, message: 'The voice benchmark could not complete.' } });
            } finally {
              benchmarkingVoice = false;
            }
            return;
          }
          case 'view.set-mode': {
            const mode = isObject(request.args) ? request.args.mode : undefined;
            if (mode !== 'meeting' && mode !== 'face-to-face') {
              reply(request.id, { ok: false, error: { code: 'invalid_mode', message: 'Choose meeting or face-to-face.' } });
              return;
            }
            const faceToFace = useFaceToFaceStore.getState();
            if (session.runner.state.getState().phase !== 'idle' || (faceToFace.phase !== 'idle' && faceToFace.phase !== 'error')) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before switching modes.' } });
              return;
            }
            faceToFace.setMode(mode);
            if (mode === 'face-to-face') await ensureFaceToFaceSettings();
            reply(request.id, { ok: true, data: status() });
            return;
          }
          case 'face-to-face.start':
          case 'face-to-face.replay': {
            const { mode, phase } = useFaceToFaceStore.getState();
            if (mode !== 'face-to-face') {
              reply(request.id, { ok: false, error: { code: 'meeting_selected', message: 'Open Face to Face first.' } });
              return;
            }
            if (checkingSystemAudio || benchmarkingVoice || session.runner.state.getState().phase !== 'idle' || (phase !== 'idle' && phase !== 'error')) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before starting Face to Face.' } });
              return;
            }
            let capture: OpenSource | undefined;
            let replayLocalSpeakers = false;
            let replayThirdLanguage: string | undefined;
            if (request.command === 'face-to-face.replay') {
              const args = isObject(request.args) ? request.args : {};
              if (args.thirdLanguage !== undefined) {
                const translation = useLineUpStore.getState().lineUp?.translation;
                const effective = resolveFaceToFaceLanguages(translation, useFaceToFaceStore.getState().languages);
                if (typeof args.thirdLanguage !== 'string' || !effective || !faceToFaceLanguageOptions(translation).includes(args.thirdLanguage)
                    || args.thirdLanguage === effective.first || args.thirdLanguage === effective.second) {
                  reply(request.id, { ok: false, error: { code: 'face_replay_bad_language', message: 'Choose a distinct third subtitle language supported by the current translation service.' } });
                  return;
                }
                replayThirdLanguage = args.thirdLanguage;
              }
              const maxSamples = 180 * SAMPLE_RATE;
              const fixtureError = { code: 'face_replay_bad_fixture', message: 'Use 1–180 seconds of 24 kHz mono PCM.' };
              if (typeof args.pcm !== 'string' || args.pcm.length > Math.ceil(2 * maxSamples / 3) * 4) {
                reply(request.id, { ok: false, error: fixtureError });
                return;
              }
              const pcm = base64ToPcm(args.pcm);
              if (pcm.length < SAMPLE_RATE || pcm.length > maxSamples) {
                reply(request.id, { ok: false, error: fixtureError });
                return;
              }
              capture = replaySource(pcm);
              replayLocalSpeakers = args.localSpeakers === true;
            }
            void startFaceToFaceRuntime(undefined, capture, { replayLocalSpeakers, replayThirdLanguage }).catch(() => {});
            reply(request.id, { ok: true, data: status() });
            return;
          }
          case 'face-to-face.stop':
            await stopFaceToFaceRuntime();
            reply(request.id, { ok: true, data: status() });
            return;
          case 'session.start': {
            if (checkingSystemAudio || benchmarkingVoice) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Wait for the current audio diagnostic to finish.' } });
              return;
            }
            if (useFaceToFaceStore.getState().mode !== 'meeting') {
              reply(request.id, { ok: false, error: { code: 'face_to_face_selected', message: 'Switch to Online Meeting in AED Translator to start an incoming-only session.' } });
              return;
            }
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
            const face = useFaceToFaceStore.getState();
            const items = face.mode === 'face-to-face'
              ? face.captions.slice(-Math.min(limit, includeText ? 24 : 100)).map((row) => ({
                speaker: row.speakerNumber ?? null,
                sourceLanguage: row.sourceLanguage ?? null,
                final: row.final,
                subtitles: faceToFaceTargets(face.runLanguages ?? face.languages).map((language) => {
                  const text = row.subtitles[language];
                  return { language, present: Boolean(text), ...(text ? textField(text, includeText) : {}) };
                }),
              }))
              : captionsOf(session.runner.conversation.snapshot(), limit, includeText);
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
              qwenWorkspaceKeyConfigured: Boolean(entries.qwen_livetranslate?.credentials.workspaceApiKey?.trim()),
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
              const reason = 'failure' in result && /^notes:[a-z0-9_-]+(:\d{3})?$/.test(result.failure)
                ? result.failure : 'notes_check_failed';
              reply(request.id, { ok: false, error: { code: reason, message: 'The service did not return usable meeting notes.' } });
              return;
            }
            reply(request.id, { ok: true, data: { service, model: configured.model, route: configured.usageProvider ?? service, topics: result.body.topics.length } });
            return;
          }
          case 'provider.configure-qwen-defaults': {
            const { lineUp, locked, choose } = useLineUpStore.getState();
            const settings = useSettingsStore.getState();
            if (locked || session.runner.state.getState().phase !== 'idle') {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before changing providers.' } });
              return;
            }
            if (!settings.settingsLoaded || !lineUp) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app settings are not ready yet.' } });
              return;
            }
            if (!presentProviders().some((provider) => provider.id === 'qwen_livetranslate')) {
              reply(request.id, { ok: false, error: { code: 'provider_unavailable', message: 'Qwen LiveTranslate is not available in this build.' } });
              return;
            }
            const translationSelected = useLineUpStore.getState().stored && lineUp.translation === 'qwen_livetranslate';
            const translationSaved = translationSelected || await choose('translation', 'qwen_livetranslate');
            const notesSaved = translationSaved && (lineUp.summarisation === BAILIAN_NOTES || await choose('summarisation', BAILIAN_NOTES));
            if (!notesSaved) {
              reply(request.id, { ok: false, error: { code: 'provider_configuration_persist_failed', message: 'The Qwen selections could not all be saved.' } });
              return;
            }
            const { notesChatForService } = await import('../lib/notes/appNotes');
            reply(request.id, { ok: true, data: { ...status(), notesConfigured: Boolean(await notesChatForService(BAILIAN_NOTES)) } });
            return;
          }
          case 'provider.configure-qwen-beijing':
          case 'provider.configure-qwen-workspace': {
            const company = request.command === 'provider.configure-qwen-workspace';
            if (session.runner.state.getState().phase !== 'idle' || useLineUpStore.getState().locked) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before changing providers.' } });
              return;
            }
            if (!useSettingsStore.getState().settingsLoaded) {
              reply(request.id, { ok: false, error: { code: 'app_not_ready', message: 'The app settings are not ready yet.' } });
              return;
            }
            const args = request.args;
            const fields = company ? ['apiKey', 'workspaceId'] : ['apiKey'];
            const workspaceId = company && isObject(args) ? normalizeBailianWorkspaceId(args.workspaceId) : null;
            if (!isObject(args) || Object.keys(args).some((key) => !fields.includes(key))
              || typeof args.apiKey !== 'string' || args.apiKey.trim().length === 0 || args.apiKey.length > 4_096
              || (company && !workspaceId)) {
              reply(request.id, { ok: false, error: {
                code: 'invalid_argument',
                message: company ? 'Expected a Beijing workspace ID and API key.' : 'Expected one nonempty apiKey value.',
              } });
              return;
            }
            const provider = presentProviders().find((item) => item.id === 'qwen_livetranslate');
            if (!provider) {
              reply(request.id, { ok: false, error: { code: 'provider_unavailable', message: 'Qwen LiveTranslate is not available in this build.' } });
              return;
            }
            const store = useProviderStore.getState();
            await store.load(provider);
            if (session.runner.state.getState().phase !== 'idle' || useLineUpStore.getState().locked) {
              reply(request.id, { ok: false, error: { code: 'session_busy', message: 'Stop the current session before changing providers.' } });
              return;
            }
            const connection = company ? BAILIAN_WORKSPACE_CONNECTION : 'bailian-cn';
            const credential = company ? 'workspaceApiKey' : 'apiKey';
            const settings = workspaceId ? { connection, workspaceId } : { connection };
            store.updateSettings(provider, settings);
            store.setCredential(provider, credential, args.apiKey.trim());
            if (!await store.flush(provider, [credential, ...Object.keys(settings)])) {
              reply(request.id, { ok: false, error: { code: 'provider_configuration_persist_failed', message: 'The Qwen configuration could not be saved.' } });
              return;
            }
            reply(request.id, { ok: true, data: {
              provider: 'qwen_livetranslate', configured: true,
              connection,
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

/** Wait for the line-up's providers to refresh readiness after the audio mode changes. */
function waitForProviderCheck(timeoutMs = 15_000): Promise<void> {
  const checking = () => {
    const plan = planFromStores();
    const { readiness } = useProviderStore.getState();
    return plan.state === 'ready' && providersIn(plan.plan).some(({ id }) => readiness[id]?.state === 'checking');
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
    unsubscribe = subscribePlan(() => {
      if (!checking()) finish();
    });
  });
}
