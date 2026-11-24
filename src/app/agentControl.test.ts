import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAgentControl } from './agentControl';
import type { AppSession } from './session';
import useAudioStore from '../stores/audioStore';
import { useLineUpStore } from '../stores/lineUpStore';
import { useFaceToFaceStore } from '../stores/faceToFaceStore';
import * as systemAudio from '../lib/audio/capture/systemAudio';
import * as micCapture from '../lib/audio/capture/mic';
import { useProviderStore } from '../stores/providerStore';
import { useRoutingStore } from '../stores/routingStore';
import { useSettingsStore } from '../stores/settingsStore';
import useLogStore from '../stores/logStore';
import { presentProviders } from '../providers/registry';
import { useUsageStore } from '../lib/usage/ledger';
import { useSessionTokenStore } from '../lib/usage/sessionTokens';
import * as environment from '../utils/environment';

vi.mock('../providers/registry', async (importOriginal) => {
  const registry = await importOriginal<typeof import('../providers/registry')>();
  const providers = ['openai', 'qwen_livetranslate', 'openai_translate'].map((id) => {
    const provider = registry.getProvider(id);
    if (!provider) throw new Error(`Missing provider fixture ${id}`);
    return provider;
  });
  return { ...registry, presentProviders: () => providers };
});
const mockProviders = presentProviders();

type ControlReply = {
  id: string;
  result: { ok: true; data: any } | { ok: false; error: { code: string; message: string } };
};

function replyFor(replies: readonly ControlReply[], id: string): ControlReply {
  const reply = replies.find((item) => item.id === id);
  if (!reply) throw new Error(`Missing agent-control reply ${id}`);
  return reply;
}

function dataOf(reply: ControlReply): any {
  if (!reply.result.ok) throw new Error(reply.result.error.message);
  return reply.result.data;
}

const initial = {
  audio: useAudioStore.getState(),
  provider: useProviderStore.getState(),
  lineUp: useLineUpStore.getState(),
  faceToFace: useFaceToFaceStore.getState(),
  routing: useRoutingStore.getState(),
  settings: useSettingsStore.getState(),
  logs: useLogStore.getState(),
  usage: useUsageStore.getState(),
  sessionTokens: useSessionTokenStore.getState(),
};

afterEach(() => {
  vi.restoreAllMocks();
  useAudioStore.setState(initial.audio, true);
  useProviderStore.setState(initial.provider, true);
  useLineUpStore.setState(initial.lineUp, true);
  useFaceToFaceStore.setState(initial.faceToFace, true);
  useRoutingStore.setState(initial.routing, true);
  useSettingsStore.setState(initial.settings, true);
  useLogStore.setState(initial.logs, true);
  useUsageStore.setState(initial.usage, true);
  useSessionTokenStore.setState(initial.sessionTokens, true);
});

function setup() {
  const source = {
    id: 'seg-src', ref: 1, side: 'source' as const, text: 'Hello', final: true, openedAt: 10,
    marks: [], language: 'en', origin: 'origin-1', speech: [],
  };
  const translation = {
    id: 'seg-translation', ref: 2, side: 'translation' as const, text: '你好', final: true, openedAt: 11,
    marks: [], language: 'zh', origin: 'origin-1', speech: [],
  };
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const session = {
    subtitle: { get: () => ({ phase: 'idle', canStart: true, idle: { kind: 'ready' } }) },
    runner: {
      state: { getState: () => ({ phase: 'idle' }) },
      conversation: { snapshot: () => [{ leg: 'participant', session: 's1', languages: { source: 'en', target: 'zh' }, segments: [source, translation], notices: [] }] },
      start,
      stop,
    },
    start,
  } as unknown as AppSession;
  const handler = vi.fn();
  const replies: ControlReply[] = [];
  const invoke = vi.fn(async (channel: string, data?: ControlReply) => {
    if (channel === 'agent-control:response' && data) replies.push(data);
  });
  const electron = { receive: (_channel: string, fn: (value: unknown) => void) => handler.mockImplementation(fn), removeListener: vi.fn(), invoke };
  useAudioStore.setState({ mode: 'participant' });
  useLineUpStore.setState({ lineUp: null, stored: false, unstoredProvider: 'openai_translate', locked: false });
  useProviderStore.setState({ entries: { openai_translate: {} as never }, readiness: { openai_translate: { state: 'ready' } as never } });
  useRoutingStore.setState({ participantSpeech: false });
  useSettingsStore.setState({ settingsLoaded: true });
  useLogStore.setState({ enabled: true, allLogs: [{ id: 1, timestamp: 't', message: 'do not return this', eventType: 'caption.translation.failed', clientId: 'participant', events: [{ type: 'caption.translation.failed', data: { request: 4, elapsedMs: 80, kind: 'http', status: 429, text: 'private transcript' } }] }] as never });
  const detach = attachAgentControl(session, electron);
  return { handler, invoke, replies, start, stop, detach };
}

describe('agent control bridge', () => {
  it('reads only the requested month and keeps quota projections separate from session counts', async () => {
    const { handler, replies, detach } = setup();
    const row = {
      month: '2026-11', activity: 'meeting' as const, provider: 'bailian-beijing', model: 'example-model',
      inputTokens: 4, outputTokens: 2, billableTokens: 6,
    };
    const tokens = { inputTokens: 4, outputTokens: 2, billableTokens: 6, totalTokens: 6, reported: true };
    const session = { ...tokens, id: 'usage-example', activity: 'meeting' as const, startedAt: Date.parse('2026-11-04'), endedAt: Date.parse('2026-11-04') };
    useUsageStore.setState({
      rows: [row, { ...row, month: '2026-10' }],
      quotas: { [row.model]: { remainingTokens: 20, capturedAt: 120, baselineTokens: 6 } },
    });
    useSessionTokenStore.setState({ meeting: tokens, history: [session, { ...session, id: 'previous', startedAt: Date.parse('2026-10-04') }] });
    handler({ id: 'usage', command: 'usage.summary', args: { month: row.month } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'usage'))).toEqual({
      month: row.month, usage: [row], sessions: [session], current: { meeting: tokens, faceToFace: null },
      quotaSnapshots: [{ model: row.model, capturedAt: 120, reportedRemainingTokens: 20, locallyEstimatedRemainingTokens: 14 }],
    });
    detach();
  });

  it('registers and handshakes, returns safe status, and keeps caption text opt-in', async () => {
    const { handler, invoke, replies, detach } = setup();
    expect(invoke).toHaveBeenCalledWith('agent-control:ready');

    handler({ id: '1', command: 'status' });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, '1'))).toMatchObject({ appReady: true, phase: 'idle', canStart: true, incomingOnly: true, provider: 'openai_translate' });

    handler({ id: '2', command: 'captions.list', args: { limit: 10 } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    const hidden = dataOf(replyFor(replies, '2'));
    expect(hidden.items[0].source).not.toHaveProperty('text');
    expect(hidden.items[0].translation).not.toHaveProperty('text');

    handler({ id: '3', command: 'captions.list', args: { includeText: true } });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    const shown = dataOf(replyFor(replies, '3'));
    expect(shown.items[0]).toMatchObject({ source: { text: 'Hello' }, translation: { text: '你好' } });
    detach();
  });

  it('lists face-to-face languages and speakers, with caption content only when requested', async () => {
    const { handler, replies, detach } = setup();
    useFaceToFaceStore.setState({
      mode: 'face-to-face', languages: { first: 'zh', second: 'ja' },
      captions: [{ id: 'test-turn', source: '下午三点见。', sourceLanguage: 'zh', speakerNumber: 1, final: true, subtitles: { zh: '下午三点见。', ja: '午後三時に会いましょう。' } }],
    });
    handler({ id: 'hidden', command: 'captions.list' });
    handler({ id: 'shown', command: 'captions.list', args: { includeText: true } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));

    expect(dataOf(replyFor(replies, 'hidden')).items).toEqual([{
      speaker: 1, sourceLanguage: 'zh', final: true,
      subtitles: [{ language: 'zh', present: true }, { language: 'ja', present: true }],
    }]);
    expect(dataOf(replyFor(replies, 'shown')).items[0].subtitles).toEqual([
      { language: 'zh', present: true, text: '下午三点见。' },
      { language: 'ja', present: true, text: '午後三時に会いましょう。' },
    ]);
    detach();
  });

  it('only starts from participant-only mode and returns allowlisted translation diagnostics', async () => {
    const { handler, replies, start, stop, detach } = setup();
    handler({ id: '4', command: 'session.start' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    handler({ id: '5', command: 'session.stop' });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    handler({ id: '6', command: 'logs.list', args: { limit: 5 } });
    await vi.waitFor(() => expect(replies.some((item) => item.id === '6')).toBe(true));
    const result = dataOf(replyFor(replies, '6'));
    expect(result.events[0].events[0].data).toEqual({ request: 4, elapsedMs: 80, status: 429, kind: 'http' });
    expect(JSON.stringify(result)).not.toContain('private transcript');
    expect(JSON.stringify(result)).not.toContain('do not return this');
    detach();
  });

  it('exports capture and provider timing without audio data or caption text', async () => {
    const { handler, replies, detach } = setup();
    const echo = { cause: 'self-capture', lagMs: 120, rho: 0.93 };
    useLogStore.setState({ allLogs: [{
      timestamp: 't', message: 'private log message',
      events: [
        { type: 'audio.echo.warning', data: { ...echo, audio: 'private samples' } },
        { type: 'audio.capture.mic', data: { requested: 'all', applied: true, audio: 'private samples' } },
        { type: 'audio.capture.participant', data: { backend: 'app', deviceId: 'private device ID' } },
        { type: 'response.text.delta', atMs: 50, data: { delta: 'private caption' } },
      ],
    }] as never });
    handler({ id: 'echo', command: 'logs.list' });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'echo')).events).toEqual([{
      timestamp: 't', events: [
        { type: 'audio.echo.warning', data: echo },
        { type: 'audio.capture.mic', data: { requested: 'all', applied: true } },
        { type: 'audio.capture.participant', data: { backend: 'app' } },
        { type: 'response.text.delta', data: { atMs: 50 } },
      ],
    }]);
    detach();
  });

  it('reports face-to-face mode and declines an incoming-audio start while it is selected', async () => {
    const { handler, replies, start, detach } = setup();
    useFaceToFaceStore.setState({ mode: 'face-to-face', phase: 'live' });
    handler({ id: 'mode', command: 'status' });
    handler({ id: 'start', command: 'session.start' });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(dataOf(replyFor(replies, 'mode'))).toMatchObject({ appMode: 'face-to-face', faceToFacePhase: 'live', canStart: false });
    expect(replyFor(replies, 'start').result).toMatchObject({ ok: false, error: { code: 'face_to_face_selected' } });
    expect(start).not.toHaveBeenCalled();
    detach();
  });

  it('reports the configured microphone and Windows default without device IDs or opening audio', async () => {
    const { handler, replies, detach } = setup();
    const selected = { deviceId: 'hardware-token', label: 'Microphone (Headset)' };
    const cable = { deviceId: 'cable-token', label: 'CABLE Input (VB-Audio Virtual Cable)', isVirtual: true };
    const getUserMedia = vi.fn();
    vi.spyOn(environment, 'getEnvironment').mockReturnValue('electron');
    vi.stubGlobal('navigator', { mediaDevices: {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'default', label: 'Default - CABLE Output' },
        { kind: 'audiooutput', deviceId: 'default', label: 'Default - CABLE Input' },
      ],
      getUserMedia,
    } });
    try {
      useAudioStore.setState({
        mode: 'both', isMonitorMuted: true, selectedInputDevice: selected,
        audioInputDevices: [selected],
        audioMonitorDevices: [
          { deviceId: 'cable-16ch', label: 'CABLE In 16ch (VB-Audio Virtual Cable)', isVirtual: true },
          cable,
        ],
        devicesLoaded: true,
        participantSources: [
          { deviceId: 'desktop-audio-loopback', label: 'System Audio' },
          { deviceId: 'auto-meeting-audio', label: 'Auto' },
          { deviceId: 'app:123', label: 'Meeting app' },
          { deviceId: 'app:456', label: 'Internal audio client' },
        ],
        selectedParticipantSource: { deviceId: 'app:123', label: 'Meeting app' }, participantCaptureWidened: true,
      });
      useRoutingStore.setState({ meeting: true, participantSpeech: true });
      useSettingsStore.setState({ textOnly: false });
      useLineUpStore.setState({ unstoredProvider: 'openai' });
      useProviderStore.setState({ readiness: {} });
      handler({ id: 'audio', command: 'audio.inputs' });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      const result = dataOf(replyFor(replies, 'audio'));
      expect(result.meetingInput).toEqual({ label: 'Microphone (Headset)', virtual: false });
      expect(result.systemDefault).toEqual({ label: 'Default - CABLE Output', virtual: true });
      expect(result.systemOutput).toEqual({ label: 'Default - CABLE Input', virtual: true });
      expect(result.virtualOutput).toEqual({ label: cable.label });
      expect(result.participantSource).toEqual({ scope: 'application', label: 'Meeting app' });
      expect(result.participantApplications).toEqual(['Meeting app', 'Internal audio client']);
      expect(result.participantCaptureWidened).toBe(true);
      expect(result.speechRoutes).toEqual({ outgoingToMeeting: true, outgoingToLocalMonitor: false, incomingToLocalPlayback: false });
      expect(result.inputs).toEqual([{ label: 'Microphone (Headset)', virtual: false }]);
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally {
      detach();
      vi.unstubAllGlobals();
    }
  });

  it('checks and releases the chosen system audio source without starting a meeting', async () => {
    const { handler, replies, start, detach } = setup();
    const release = vi.fn(async () => {});
    const listen = vi.fn();
    const open = vi.spyOn(systemAudio, 'openSystemAudio').mockImplementation(async (settings) => {
      expect(settings.sourceId()).toBe('app:123');
      expect(settings.muted()).toBe(true);
      return { stop: release, onPcm: listen, onEnded: vi.fn(), onDegraded: vi.fn() };
    });
    useAudioStore.setState({ selectedParticipantSource: { deviceId: 'app:123', label: 'Test meeting' } });
    handler({ id: 'audio', command: 'audio.system-check' });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'audio'))).toEqual({ captureOpened: true });
    expect(open).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    detach();
  });

  it('checks the automatically detected app without retargeting the saved source', async () => {
    const { handler, replies, start, detach } = setup();
    const release = vi.fn(async () => {});
    let connectMeeting: () => void = () => {};
    let publishLevel: (pcm: Int16Array) => void = () => {};
    const open = vi.spyOn(systemAudio, 'openSystemAudio').mockImplementation(async (settings) => {
      expect(settings.sourceId()).toBe('auto-meeting-audio');
      expect(settings.muted()).toBe(false);
      connectMeeting = () => {
        settings.captureStarted?.('app');
        settings.autoResolved?.({ deviceId: 'app:456', label: 'Meeting browser' });
        publishLevel(Int16Array.of(8192));
      };
      return {
        stop: release,
        onPcm: (listener) => { publishLevel = listener; return () => {}; },
        onEnded: vi.fn(),
        onDegraded: vi.fn(),
      };
    });
    useAudioStore.setState({ selectedParticipantSource: { deviceId: 'app:123', label: 'Manual source' } });
    handler({ id: 'auto', command: 'audio.system-check', args: { auto: true } });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(replies).toHaveLength(0);
    connectMeeting();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'auto'))).toEqual({ captureOpened: true, backend: 'app', resolvedApp: 'Meeting browser', peakLevel: 0.25 });
    expect(useAudioStore.getState().selectedParticipantSource?.deviceId).toBe('app:123');
    expect(release).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    detach();
  });

  it('measures a local auto-app echo sample on the selected or exact-label mic without starting a session', async () => {
    vi.useFakeTimers();
    const { handler, replies, start, detach } = setup();
    const selected = { deviceId: 'headset-mic', label: 'INZONE Headset', isVirtual: false };
    const physical = { deviceId: 'realtek-mic', label: 'Realtek Microphone', isVirtual: false };
    useAudioStore.setState({ selectedInputDevice: selected, audioInputDevices: [selected, physical], selectedParticipantSource: { deviceId: 'saved-app', label: 'Saved source' }, echoCancellationMode: 'all' });
    const stopMic = vi.fn(async () => {});
    const stopSystem = vi.fn(async () => {});
    let micListener: ((pcm: Int16Array) => void) | undefined;
    let systemListener: ((pcm: Int16Array) => void) | undefined;
    let listenersReady!: () => void;
    const attached = new Promise<void>((resolve) => { listenersReady = resolve; });
    vi.spyOn(micCapture, 'openMic').mockImplementation(async (settings) => {
      expect(settings.deviceId()).toBe('realtek-mic');
      settings.captureStarted?.('all', true);
      return { stop: stopMic, onPcm: (listener: (pcm: Int16Array) => void) => { micListener = listener; if (systemListener) listenersReady(); return () => {}; }, onEnded: () => () => {}, onDegraded: vi.fn() } as never;
    });
    vi.spyOn(systemAudio, 'openSystemAudio').mockImplementation(async (settings) => {
      expect(settings.sourceId()).toBe('auto-meeting-audio');
      settings.captureStarted?.('app');
      settings.autoResolved?.({ deviceId: 'app:bili', label: '哔哩哔哩' });
      return { stop: stopSystem, onPcm: (listener: (pcm: Int16Array) => void) => { systemListener = listener; if (micListener) listenersReady(); return () => {}; }, onEnded: vi.fn(), onDegraded: vi.fn() } as never;
    });
    handler({ id: 'echo', command: 'audio.echo-check', args: { micLabel: 'Realtek Microphone' } });
    await attached;
    const pcm = Int16Array.from({ length: 480 }, (_, i) => Math.round(8_000 * Math.sin(i * 0.08)));
    systemListener?.(pcm);
    micListener?.(pcm);
    await vi.advanceTimersByTimeAsync(5_500);
    await vi.runAllTicks();
    expect(replies).toHaveLength(1);
    expect(dataOf(replyFor(replies, 'echo'))).toMatchObject({ selectedApp: '哔哩哔哩', microphone: 'Realtek Microphone', configuredAec: 'all', appliedAec: true, durationMs: 5_500 });
    expect(dataOf(replyFor(replies, 'echo')).referenceRms).toBeGreaterThan(0);
    expect(stopMic).toHaveBeenCalledOnce();
    expect(stopSystem).toHaveBeenCalledOnce();
    expect(useAudioStore.getState().selectedInputDevice?.deviceId).toBe('headset-mic');
    expect(useAudioStore.getState().selectedParticipantSource?.deviceId).toBe('saved-app');
    expect(start).not.toHaveBeenCalled();
    detach();
    vi.useRealTimers();
  });

  it('opens an idle mode without starting audio and guards a running face-to-face session', async () => {
    const { handler, replies, start, detach } = setup();
    handler({ id: 'face-to-face', command: 'view.set-mode', args: { mode: 'face-to-face' } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'face-to-face'))).toMatchObject({ appMode: 'face-to-face', faceToFacePhase: 'idle' });
    expect(start).not.toHaveBeenCalled();
    useFaceToFaceStore.getState().setPhase('live');
    handler({ id: 'meeting', command: 'view.set-mode', args: { mode: 'meeting' } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replyFor(replies, 'meeting').result).toMatchObject({ error: { code: 'session_busy' } });
    expect(useFaceToFaceStore.getState().mode).toBe('face-to-face');
    detach();
  });

  it('reports credential presence as booleans only', async () => {
    const { handler, replies, detach } = setup();
    const store = useProviderStore.getState();
    const load = vi.spyOn(store, 'load').mockResolvedValue();
    useProviderStore.setState({ entries: {
      openai: { settings: {}, credentials: { apiKey: 'synthetic-openai-key' }, pair: { source: 'ja', target: 'en' } },
      qwen_livetranslate: { settings: {}, credentials: { apiKey: '', workspaceApiKey: 'synthetic-workspace-key' }, pair: { source: 'ja', target: 'en' } },
    } as never });

    handler({ id: 'credentials', command: 'credentials.status', args: {} });
    await vi.waitFor(() => expect(replies.some((item) => item.id === 'credentials')).toBe(true));

    expect(dataOf(replyFor(replies, 'credentials'))).toEqual({ openaiConfigured: true, qwenConfigured: false, qwenWorkspaceKeyConfigured: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(replyFor(replies, 'credentials'))).not.toContain('synthetic-openai-key');
    expect(JSON.stringify(replyFor(replies, 'credentials'))).not.toContain('synthetic-workspace-key');
    detach();
  });

  it('selects Qwen translation and notes without changing either Qwen credential', async () => {
    const { handler, replies, detach } = setup();
    const lineUp = { transcription: 'qwen_livetranslate', translation: 'qwen_livetranslate', speech: 'qwen_livetranslate', summarisation: 'openai' };
    useLineUpStore.setState({ lineUp, stored: true, unstoredProvider: null });
    const choose = vi.spyOn(useLineUpStore.getState(), 'choose').mockImplementation(async (stage, id) => {
      const next = { ...lineUp, [stage]: id };
      useLineUpStore.setState({ lineUp: next });
      return { lineUp: next, moved: [] };
    });
    useSettingsStore.setState({ notesBailianModel: 'qwen-flash' });
    const setNotesModel = vi.spyOn(useSettingsStore.getState(), 'setNotesBailianModel').mockImplementation(async (notesBailianModel) => {
      useSettingsStore.setState({ notesBailianModel });
    });
    const qwen = {
      settings: { connection: 'bailian-cn' },
      credentials: { apiKey: 'personal-key-for-test-only', workspaceApiKey: 'workspace-key-for-test-only' },
    };
    useProviderStore.setState({ entries: { qwen_livetranslate: qwen } as never });

    handler({ id: 'qwen-defaults', command: 'provider.configure-qwen-defaults' });
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    expect(setNotesModel).toHaveBeenCalledExactlyOnceWith('qwen3.8-flash');
    expect(choose).toHaveBeenCalledExactlyOnceWith('summarisation', 'bailian_notes');
    expect(useProviderStore.getState().entries.qwen_livetranslate).toBe(qwen);
    expect(dataOf(replyFor(replies, 'qwen-defaults'))).toMatchObject({ notesConfigured: true });
    expect(JSON.stringify(replies)).not.toContain('key-for-test-only');
    detach();
  });

  it('configures a workspace through its distinct credential and returns no key', async () => {
    const { handler, replies, detach } = setup();
    const store = useProviderStore.getState();
    vi.spyOn(store, 'load').mockResolvedValue();
    const setCredential = vi.spyOn(store, 'setCredential').mockImplementation(() => {});
    const updateSettings = vi.spyOn(store, 'updateSettings').mockImplementation(() => {});
    const flush = vi.spyOn(store, 'flush').mockResolvedValue(true);
    const workspaceId = 'llm-testcompany';
    const apiKey = 'synthetic-company-key-for-test-only';
    handler({ id: 'workspace', command: 'provider.configure-qwen-workspace', args: { apiKey, workspaceId } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'workspace'))).toMatchObject({
      provider: 'qwen_livetranslate', connection: 'bailian-workspace', configured: true,
    });
    expect(setCredential).toHaveBeenCalledExactlyOnceWith(mockProviders[1], 'workspaceApiKey', apiKey);
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith(mockProviders[1], { connection: 'bailian-workspace', workspaceId });
    expect(flush).toHaveBeenCalledWith(mockProviders[1], ['workspaceApiKey', 'connection', 'workspaceId']);
    expect(JSON.stringify(replies)).not.toContain(apiKey);
    detach();
  });

  it('configures Beijing Qwen with a synthetic key without changing selection or pair', async () => {
    const { handler, replies, detach } = setup();
    const store = useProviderStore.getState();
    const load = vi.spyOn(store, 'load').mockResolvedValue();
    const setCredential = vi.spyOn(store, 'setCredential').mockImplementation(() => {});
    const updateSettings = vi.spyOn(store, 'updateSettings').mockImplementation(() => {});
    const setPair = vi.spyOn(store, 'setPair').mockImplementation(() => {});
    const flush = vi.spyOn(store, 'flush').mockResolvedValue(true);
    const originalLineUp = useLineUpStore.getState();
    const marker = 'synthetic-qwen-key-for-test-only';

    handler({ id: '7', command: 'provider.configure-qwen-beijing', args: { apiKey: ` ${marker} ` } });
    await vi.waitFor(() => expect(replies.some((item) => item.id === '7')).toBe(true));

    const response = replyFor(replies, '7');
    expect(dataOf(response)).toMatchObject({
      provider: 'qwen_livetranslate', configured: true,
      connection: 'bailian-cn', sessionStarted: false,
    });
    expect(load).toHaveBeenCalledWith(mockProviders[1]);
    expect(setCredential).toHaveBeenCalledWith(mockProviders[1], 'apiKey', marker);
    expect(updateSettings).toHaveBeenCalledWith(mockProviders[1], { connection: 'bailian-cn' });
    expect(setPair).not.toHaveBeenCalled();
    expect(useLineUpStore.getState()).toBe(originalLineUp);
    expect(flush).toHaveBeenCalledWith(mockProviders[1], ['apiKey', 'connection']);
    expect(JSON.stringify(response)).not.toContain(marker);
    detach();
  });
});
