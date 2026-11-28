import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAgentControl } from './agentControl';
import type { AppSession } from './session';
import useAudioStore from '../stores/audioStore';
import { useLineUpStore } from '../stores/lineUpStore';
import { useFaceToFaceStore } from '../stores/faceToFaceStore';
import * as systemAudio from '../lib/audio/capture/systemAudio';
import { useProviderStore } from '../stores/providerStore';
import { useRoutingStore } from '../stores/routingStore';
import { useSettingsStore } from '../stores/settingsStore';
import useLogStore from '../stores/logStore';
import { presentProviders } from '../providers/registry';
import { useUsageStore } from '../lib/usage/ledger';
import { useSessionTokenStore } from '../lib/usage/sessionTokens';
import * as environment from '../utils/environment';
import * as faceToFaceRuntime from '../lib/faceToFace/runtime';

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
    audioIfLoaded: () => null,
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
  return { handler, invoke, replies, start, stop, detach, session };
}

describe('agent control bridge', () => {
  it('passes a temporary third target to replay and rejects unsupported or duplicate targets', async () => {
    const { handler, replies, detach } = setup();
    useFaceToFaceStore.setState({ mode: 'face-to-face', phase: 'idle', languages: { first: 'zh', second: 'ja' } });
    useLineUpStore.setState({ lineUp: { transcription: 'qwen_livetranslate', translation: 'qwen_livetranslate', speech: 'qwen_livetranslate', summarisation: null }, stored: true });
    const startReplay = vi.spyOn(faceToFaceRuntime, 'startFaceToFaceRuntime').mockResolvedValue(async () => {});
    const pcm = Buffer.alloc(48_000).toString('base64');
    handler({ id: 'replay-third', command: 'face-to-face.replay', args: { pcm, thirdLanguage: 'de' } });
    await vi.waitFor(() => expect(startReplay).toHaveBeenCalledOnce());
    expect(startReplay).toHaveBeenCalledWith(undefined, expect.any(Function), {
      replayLocalSpeakers: false, replayThirdLanguage: 'de',
    });
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'zh', second: 'ja' });

    handler({ id: 'bad-language', command: 'face-to-face.replay', args: { pcm, thirdLanguage: 'xx' } });
    handler({ id: 'duplicate-language', command: 'face-to-face.replay', args: { pcm, thirdLanguage: 'ja' } });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replyFor(replies, 'bad-language').result).toMatchObject({ ok: false, error: { code: 'face_replay_bad_language' } });
    expect(replyFor(replies, 'duplicate-language').result).toMatchObject({ ok: false, error: { code: 'face_replay_bad_language' } });
    expect(startReplay).toHaveBeenCalledOnce();
    detach();
  });

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

  it('reports the current line-up translation service and whether Face to Face can use it', async () => {
    const { handler, replies, detach } = setup();
    useFaceToFaceStore.setState({ mode: 'face-to-face' });
    useLineUpStore.setState({ lineUp: { transcription: 'soniox', translation: 'soniox', speech: 'edge', summarisation: null }, stored: true });
    handler({ id: 'unsupported', command: 'status' });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(dataOf(replyFor(replies, 'unsupported'))).toMatchObject({
      faceToFaceProvider: null,
      faceToFaceTranslationService: 'soniox',
      faceToFaceUnavailableReason: 'unsupported_translation_service',
      faceToFaceService: { supported: false, readiness: null },
    });

    useLineUpStore.setState({ lineUp: { transcription: 'openai_translate', translation: 'openai_translate', speech: 'openai_translate', summarisation: null }, stored: true });
    handler({ id: 'supported', command: 'status' });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(dataOf(replyFor(replies, 'supported'))).toMatchObject({
      faceToFaceProvider: 'openai_translate',
      faceToFaceTranslationService: 'openai_translate',
      faceToFaceUnavailableReason: null,
      faceToFaceService: { supported: true, readiness: { state: 'ready' } },
    });
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
    const { handler, replies, detach, session } = setup();
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
      const audioIfLoaded = vi.spyOn(session, 'audioIfLoaded').mockReturnValue({
        capture: {},
      } as never);
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
      expect(result.participantPcmRuntime).toBeNull();
      expect(result.speechRoutes).toEqual({ outgoingToMeeting: true, outgoingToLocalMonitor: false, incomingToLocalPlayback: false });
      expect(result.inputs).toEqual([{ label: 'Microphone (Headset)', virtual: false }]);
      expect(getUserMedia).not.toHaveBeenCalled();

      const participantPcmRuntime = {
        sampleRate: 24_000, threshold: 0.012, totalSamples: 48_000,
        blocksAtOrAboveThreshold: 20, samplesInThresholdBlocks: 48_000,
        thresholdBlockDurationMs: 2_000,
      };
      audioIfLoaded.mockReturnValue({
        capture: {
          participantPcmRuntime: () => participantPcmRuntime,
        },
      } as never);
      handler({ id: 'audio-with-pcm', command: 'audio.inputs' });
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(dataOf(replyFor(replies, 'audio-with-pcm')).participantPcmRuntime).toEqual(participantPcmRuntime);
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

  it('measures an exact Windows playback source without changing the saved choice', async () => {
    const { handler, invoke, replies, start, detach } = setup();
    const endpoint = { deviceId: 'endpoint:speakers', label: 'Speakers (Realtek)' };
    const previous = invoke.getMockImplementation();
    invoke.mockImplementation(async (channel, data) => {
      if (channel === 'list-system-audio-sources') return [endpoint] as never;
      return previous?.(channel, data);
    });
    const release = vi.fn(async () => {});
    vi.spyOn(systemAudio, 'openSystemAudio').mockImplementation(async (settings) => {
      expect(settings.sourceId()).toBe(endpoint.deviceId);
      expect(settings.muted()).toBe(false);
      settings.captureStarted?.('endpoint');
      return {
        stop: release,
        onPcm: (listener) => { listener(Int16Array.of(4096)); return () => {}; },
        onEnded: vi.fn(),
        onDegraded: vi.fn(),
      };
    });
    useAudioStore.setState({ selectedParticipantSource: { deviceId: 'app:123', label: 'Saved app' } });
    handler({ id: 'endpoint', command: 'audio.system-check', args: { endpointLabel: endpoint.label } });
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 2_000 });
    expect(dataOf(replyFor(replies, 'endpoint'))).toEqual({ captureOpened: true, backend: 'endpoint', peakLevel: 0.125 });
    expect(useAudioStore.getState().selectedParticipantSource?.deviceId).toBe('app:123');
    expect(release).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    detach();
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

    expect(setNotesModel).not.toHaveBeenCalled();
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
