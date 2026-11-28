import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startQwen: vi.fn(),
  startOpenai: vi.fn(),
  translateCaption: vi.fn(),
  openSource: vi.fn(),
  micSettings: vi.fn(),
  selectedMicId: vi.fn((): string | undefined => 'shared-online-mic'),
  audioDevicesLoaded: vi.fn(() => true),
  micMuted: vi.fn(() => false),
  micListed: vi.fn(() => true),
  micUnusable: vi.fn(() => false),
  sessionStop: vi.fn(async () => {}),
  sourceStop: vi.fn(async () => {}),
  speakerReady: vi.fn(async () => {}),
  speakerEmbed: vi.fn(async () => new Float32Array(192)),
  speakerDispose: vi.fn(),
  startNotes: vi.fn(),
}));

vi.mock('./speakerEmbedding', () => ({
  SpeakerEmbedder: class {
    ready = mocks.speakerReady;
    embed = mocks.speakerEmbed;
    dispose = mocks.speakerDispose;
  },
}));
vi.mock('./speakerClusters', () => ({
  SpeakerClusters: class {
    assign() { return 0; }
  },
}));
vi.mock('../../providers/qwen_livetranslate/provider', async () => {
  const { qwenCredentials, qwenLanguages } = await import('../../providers/qwen_livetranslate/settings');
  return {
    qwenLiveTranslateProvider: {
      credentials: qwenCredentials,
      languages: qwenLanguages,
      units: [{ start: (...args: unknown[]) => mocks.startQwen(...args) }],
    },
  };
});
vi.mock('../../providers/openai_translate/provider', async () => {
  const { translateCredentials, translateLanguages } = await import('../../providers/openai_translate/settings');
  return {
    openaiTranslateProvider: {
      credentials: translateCredentials,
      languages: translateLanguages,
      units: [{ start: (...args: unknown[]) => mocks.startOpenai(...args) }],
    },
  };
});
vi.mock('../../providers/openai_translate/textTranslation', () => ({
  translateCaption: (...args: unknown[]) => mocks.translateCaption(...args),
}));
vi.mock('../audio/appCapture', () => ({
  micSettings: () => ({
    devicesLoaded: () => mocks.audioDevicesLoaded(),
    deviceId: () => mocks.selectedMicId(),
    deviceLabel: () => 'Shared online microphone',
    isListed: () => mocks.micListed(),
    isUnusable: () => mocks.micUnusable(),
    muted: () => mocks.micMuted(),
  }),
}));
vi.mock('../audio/capture/mic', () => ({
  openMic: (...args: unknown[]) => {
    mocks.micSettings(args[0]);
    return mocks.openSource('speaker', (args[1] as AbortSignal));
  },
}));
vi.mock('../notes/appNotes', () => ({ appNotesRunner: () => ({ start: (...args: unknown[]) => mocks.startNotes(...args) }) }));

import { faceToFaceCaptionLanguageSummary, getFaceToFaceDiagnostics, readFaceToFaceInputPeak, startFaceToFaceNotesAfterSession, startFaceToFaceRuntime, stopFaceToFaceRuntime } from './runtime';
import { LEVEL_STALE_MS } from '../audio/levelMeter';
import { realClock } from '../contract/clock';
import { QWEN_DEFAULTS } from '../../providers/qwen_livetranslate/settings';
import { TRANSLATE_DEFAULTS } from '../../providers/openai_translate/settings';
import { BAILIAN_ENDPOINT_ID, BAILIAN_WORKSPACE_CONNECTION } from '../../providers/qwen_livetranslate/endpoints';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { useProviderStore } from '../../stores/providerStore';
import { useLineUpStore } from '../../stores/lineUpStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AdapterEvents } from '../contract/adapter';
import type { QwenConfig } from '../../providers/qwen_livetranslate/config';

function fakeSession() {
  return {
    appendAudio: vi.fn(), appendText: vi.fn(), beginTurn: vi.fn(), endTurn: vi.fn(), cancelTurn: vi.fn(),
    stop: mocks.sessionStop, info: {},
  };
}

function fakeSource() {
  return {
    onPcm: vi.fn(() => () => {}), onEnded: vi.fn(() => () => {}), onDegraded: vi.fn(() => () => {}),
    stop: mocks.sourceStop,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useProviderStore.setState({
    entries: { qwen_livetranslate: { settings: QWEN_DEFAULTS, credentials: { apiKey: 'test-only-key' } } as never },
  });
  useLineUpStore.setState({ lineUp: { transcription: 'qwen_livetranslate', translation: 'qwen_livetranslate', speech: 'qwen_livetranslate', summarisation: null }, stored: true });
  useFaceToFaceStore.setState({ mode: 'face-to-face', phase: 'starting', error: null, languages: { first: 'zh', second: 'ja' }, captions: [] });
  useSettingsStore.setState({ localSpeakerRecognition: false });
});

afterEach(async () => {
  await stopFaceToFaceRuntime();
  mocks.selectedMicId.mockReturnValue('shared-online-mic');
  mocks.audioDevicesLoaded.mockReturnValue(true);
  mocks.micMuted.mockReturnValue(false);
  mocks.micListed.mockReturnValue(true);
  mocks.micUnusable.mockReturnValue(false);
  useFaceToFaceStore.setState({ mode: 'meeting', phase: 'idle', error: null, languages: { first: 'zh', second: 'ja' }, captions: [] });
  useProviderStore.setState({ entries: {} });
});

describe('face-to-face runtime ownership', () => {
  it('meters only the current input PCM and clears on silence, stalled capture, and stop', async () => {
    let deliver!: (pcm: Int16Array) => void;
    const source = { ...fakeSource(), onPcm(callback: typeof deliver) { deliver = callback; return () => {}; } };
    const clock = vi.spyOn(realClock, 'now').mockReturnValue(10_000);
    const session = fakeSession();
    mocks.startQwen.mockResolvedValueOnce(session);
    mocks.openSource.mockResolvedValueOnce(source);
    try {
      const close = await startFaceToFaceRuntime();
      expect(readFaceToFaceInputPeak()).toBe(0);
      const frame = Int16Array.of(700, -16384, 12);
      deliver(frame);
      expect(session.appendAudio).toHaveBeenLastCalledWith(frame);
      expect(getFaceToFaceDiagnostics()).toMatchObject({ input: 'microphone', inputPeak: 0.5, peak: 16384 });
      deliver(Int16Array.of(0, 0));
      expect(getFaceToFaceDiagnostics()).toMatchObject({ inputPeak: 0, peak: 16384 });
      deliver(Int16Array.of(-32768));
      expect(readFaceToFaceInputPeak()).toBe(1);
      clock.mockReturnValue(10_000 + LEVEL_STALE_MS + 1);
      expect(readFaceToFaceInputPeak()).toBe(0);
      deliver(frame);
      const stopping = close();
      expect(readFaceToFaceInputPeak()).toBe(0);
      // A frame from a detached callback cannot light up the next session.
      deliver(frame);
      expect(readFaceToFaceInputPeak()).toBe(0);
      await stopping;
      expect(session.appendAudio).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['kizunaai_qwen', 'unsupported_translation_service'],
    ['openai', 'unsupported_translation_service'],
    ['openai_live', 'unsupported_translation_service'],
    ['bing', 'unsupported_translation_service'],
    [null, 'lineup_pending'],
  ] as const)('refuses translation selection %s without starting a different provider', async (translation, errorCode) => {
    useLineUpStore.setState({ lineUp: translation === null ? null : {
      transcription: translation, translation, speech: translation, summarisation: null,
    }, stored: true });
    await expect(startFaceToFaceRuntime()).rejects.toMatchObject({ code: errorCode });
    expect(mocks.startQwen).not.toHaveBeenCalled();
    expect(mocks.startOpenai).not.toHaveBeenCalled();
    expect(useFaceToFaceStore.getState().phase).toBe('error');
  });


  it('opens the microphone selected by the shared online audio setting, while unmuting only this live source', async () => {
    mocks.selectedMicId.mockReturnValue('usb-headset-mic');
    mocks.openSource.mockResolvedValue(fakeSource());
    await startFaceToFaceRuntime();

    const settings = mocks.micSettings.mock.calls[0][0] as { deviceId: () => string | undefined; deviceLabel: () => string; muted: () => boolean };
    expect(settings.deviceId()).toBe('usb-headset-mic');
    expect(settings.deviceLabel()).toBe('Shared online microphone');
    expect(settings.muted()).toBe(false);
  });

  it.each([
    ['mic is explicitly off', () => mocks.micMuted.mockReturnValue(true), 'microphone_muted'],
    ['shared audio settings are still loading', () => mocks.audioDevicesLoaded.mockReturnValue(false), 'audio_settings_loading'],
    ['there is no selected microphone', () => mocks.selectedMicId.mockReturnValue(undefined), 'no_microphone_selected'],
    ['the selected microphone is no longer listed', () => mocks.micListed.mockReturnValue(false), 'microphone_unavailable'],
    ['the selected microphone is marked unusable', () => mocks.micUnusable.mockReturnValue(true), 'microphone_unavailable'],
  ] as const)('refuses a real microphone start when %s before opening the provider', async (_condition, arrange, code) => {
    arrange();
    await expect(startFaceToFaceRuntime()).rejects.toMatchObject({ code });
    expect(mocks.startQwen).not.toHaveBeenCalled();
    expect(mocks.startOpenai).not.toHaveBeenCalled();
  });

  it('keeps the shared microphone mute callback live after the face-to-face session starts', async () => {
    mocks.openSource.mockResolvedValue(fakeSource());
    const close = await startFaceToFaceRuntime();
    const settings = mocks.micSettings.mock.calls[0][0] as { muted: () => boolean };
    expect(settings.muted()).toBe(false);
    mocks.micMuted.mockReturnValue(true);
    expect(settings.muted()).toBe(true);
    await close();
  });

  it('keeps synthetic replay independent of microphone readiness and mute settings', async () => {
    mocks.audioDevicesLoaded.mockReturnValue(false);
    mocks.micMuted.mockReturnValue(true);
    mocks.selectedMicId.mockReturnValue(undefined);
    const close = await startFaceToFaceRuntime(undefined, async () => fakeSource());
    expect(mocks.startQwen).toHaveBeenCalledTimes(1);
    await close();
  });

  it('reads the current translation choice at start instead of a face-to-face provider preference', async () => {
    mocks.openSource.mockResolvedValue(fakeSource());
    const before = useLineUpStore.getState().lineUp;
    useLineUpStore.setState({ lineUp: { transcription: 'openai_translate', translation: 'openai_translate', speech: 'openai_translate', summarisation: null }, stored: true });
    useProviderStore.setState({
      entries: { openai_translate: { settings: TRANSLATE_DEFAULTS, credentials: { apiKey: 'shared-openai-key' } } as never },
    });
    mocks.startOpenai.mockResolvedValue(fakeSession());

    await startFaceToFaceRuntime();
    expect(mocks.startOpenai).toHaveBeenCalledOnce();
    expect(mocks.startQwen).not.toHaveBeenCalled();
    expect(useLineUpStore.getState().lineUp?.translation).toBe('openai_translate');
    expect(before?.translation).toBe('qwen_livetranslate');
  });

  it('does not invent a default or substitute device when the shared audio setting has no selection', async () => {
    mocks.selectedMicId.mockReturnValue(undefined);
    await expect(startFaceToFaceRuntime()).rejects.toMatchObject({ code: 'no_microphone_selected' });
    expect(mocks.startQwen).not.toHaveBeenCalled();
    expect(mocks.openSource).not.toHaveBeenCalled();
  });

  it('opens the same effective subtitle pair as the menu after a service switch, preserving the saved pair', async () => {
    useFaceToFaceStore.setState({ languages: { first: 'uk', second: 'de' } });
    useLineUpStore.setState({ lineUp: { transcription: 'openai_translate', translation: 'openai_translate', speech: 'openai_translate', summarisation: null }, stored: true });
    useProviderStore.setState({ entries: { openai_translate: { settings: TRANSLATE_DEFAULTS, credentials: { apiKey: 'test-only-key' } } as never } });
    mocks.startOpenai.mockResolvedValue(fakeSession());
    const close = await startFaceToFaceRuntime(undefined, async () => fakeSource());
    expect(getFaceToFaceDiagnostics()?.targetLanguages).toEqual(['zh', 'de']);
    expect(mocks.startOpenai.mock.calls[0][0].config.sourceLanguageHints).toEqual(['zh', 'de']);
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'uk', second: 'de' });
    await close();
  });

  it('adds a temporary replay target without changing saved languages and summarizes all caption completion metadata', async () => {
    useLineUpStore.setState({ lineUp: { transcription: 'openai_translate', translation: 'openai_translate', speech: 'openai_translate', summarisation: null }, stored: true });
    useProviderStore.setState({
      entries: { openai_translate: { settings: TRANSLATE_DEFAULTS, credentials: { apiKey: 'test-openai-key' } } as never },
    });
    mocks.startOpenai.mockResolvedValue(fakeSession());

    const close = await startFaceToFaceRuntime(undefined, async () => fakeSource(), { replayThirdLanguage: 'en' });
    expect(getFaceToFaceDiagnostics()?.targetLanguages).toEqual(['zh', 'ja', 'en']);
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'zh', second: 'ja' });
    await close();

    const summary = faceToFaceCaptionLanguageSummary([
      { id: 'one', source: 'PRIVATE ONE', sourceLanguage: 'zh-CN', subtitles: { zh: 'PRIVATE ONE', ja: '日本語', en: 'English' }, final: true },
      { id: 'two', source: 'PRIVATE TWO', sourceLanguage: 'ja-JP', subtitles: { zh: '中文', ja: 'PRIVATE TWO' }, final: false },
      { id: 'three', source: 'PRIVATE THREE', subtitles: { zh: '中文' }, final: true },
    ], ['zh', 'ja', 'en']);
    expect(summary.sourceCounts).toEqual({ zh: 1, ja: 1, unknown: 1 });
    expect(summary.targetCounts).toEqual({ zh: 3, ja: 2, en: 1 });
    expect(summary.rows).toEqual([
      { speaker: null, sourceLanguage: 'zh-CN', sourceLang: 'zh', targetLangs: ['zh', 'ja', 'en'], complete: true, final: true },
      { speaker: null, sourceLanguage: 'ja-JP', sourceLang: 'ja', targetLangs: ['zh', 'ja'], complete: false, final: false },
      { speaker: null, sourceLanguage: null, sourceLang: null, targetLangs: ['zh'], complete: false, final: true },
    ]);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  });

  it('starts existing app notes only for a manually ended, fully archived session with notes enabled', () => {
    const ready = { recordId: 'face-id', notesAfterSession: true, normalEnd: true, replay: false,
      history: { kept: true, complete: true, transcriptId: 7 } };
    expect(startFaceToFaceNotesAfterSession(ready)).toBe(true);
    expect(mocks.startNotes).toHaveBeenCalledWith('face-id', undefined, 7);
    mocks.startNotes.mockClear();
    for (const blocked of [
      { ...ready, notesAfterSession: false },
      { ...ready, normalEnd: false },
      { ...ready, replay: true },
      { ...ready, history: { ...ready.history, complete: false } },
      { ...ready, history: { ...ready.history, kept: false } },
      { ...ready, history: { ...ready.history, transcriptId: null } },
    ]) {
      expect(startFaceToFaceNotesAfterSession(blocked)).toBe(false);
    }
    expect(mocks.startNotes).not.toHaveBeenCalled();
  });

  it('publishes the caption before local recognition and keeps one speaker across changing provider IDs', async () => {
    let primaryEvents!: AdapterEvents;
    let primaryConfig!: QwenConfig;
    mocks.startQwen.mockImplementationOnce(async (request: { config: QwenConfig }, events: AdapterEvents) => {
      primaryEvents = events;
      primaryConfig = request.config;
      return fakeSession();
    });
    useSettingsStore.setState({ localSpeakerRecognition: true });
    const close = await startFaceToFaceRuntime(undefined, async () => fakeSource());
    const audio = primaryConfig.turnAudio!;
    audio.append(new Int16Array(96_000).fill(600));
    audio.speechStarted('one', 0);
    primaryEvents.segmentOpened({ ref: 10, side: 'source', origin: 'one', person: '1.7' });
    primaryEvents.segmentText({ ref: 10, text: '最初の発言', language: 'ja' });
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({ source: '最初の発言' });
    expect(useFaceToFaceStore.getState().captions[0].speakerNumber).toBeUndefined();
    audio.speechStopped('one', 2_000);
    primaryEvents.frame({ direction: 'in', type: 'input_audio_buffer.speech_stopped', payload: { itemId: 'one' } });
    audio.speechStarted('two', 2_000);
    primaryEvents.segmentOpened({ ref: 11, side: 'source', origin: 'two', person: '1.97' });
    audio.speechStopped('two', 4_000);
    primaryEvents.frame({ direction: 'in', type: 'input_audio_buffer.speech_stopped', payload: { itemId: 'two' } });
    await vi.waitFor(() => expect(useFaceToFaceStore.getState().captions.map(({ speakerNumber }) => speakerNumber)).toEqual([1, 1]));
    expect(mocks.speakerEmbed.mock.calls[0]).toEqual([expect.any(Float32Array), 24_000]);
    expect(getFaceToFaceDiagnostics()?.localSpeakerRecognition).toMatchObject({ status: 'active', assigned: 2 });
    await close();
    expect(mocks.speakerDispose).toHaveBeenCalled();
  });

  it('continues subtitling with provider labels when the local model is unavailable', async () => {
    let primaryEvents!: AdapterEvents;
    mocks.speakerReady.mockRejectedValueOnce(new Error('Model unavailable'));
    mocks.startQwen.mockImplementationOnce(async (_request, events: AdapterEvents) => {
      primaryEvents = events;
      return fakeSession();
    });
    useSettingsStore.setState({ localSpeakerRecognition: true });
    await startFaceToFaceRuntime(undefined, async () => fakeSource());
    primaryEvents.segmentOpened({ ref: 10, side: 'source', origin: 'one', person: '1.7' });
    primaryEvents.segmentOpened({ ref: 11, side: 'source', origin: 'two', person: '1.8' });
    expect(useFaceToFaceStore.getState().captions.map(({ speakerNumber }) => speakerNumber)).toEqual([1, 2]);
    expect(useFaceToFaceStore.getState().localSpeakerStatus).toBe('unavailable');
  });

  it('join synthetic replay speaker labels to the app caption without including its text', async () => {
    let events!: AdapterEvents;
    mocks.startQwen.mockImplementationOnce(async (_request, sink: AdapterEvents) => {
      events = sink;
      return fakeSession();
    });
    const close = await startFaceToFaceRuntime(undefined, async () => fakeSource());
    events.frame({ direction: 'in', type: 'input_audio_buffer.speech_started', payload: { itemId: 'heard', speaker: 7, audioStartMs: 650 } });
    events.segmentOpened({ ref: 1, side: 'source', origin: 'heard', person: '1.7' });
    events.segmentText({ ref: 1, text: 'これは試験です。', language: 'ja' });
    events.segmentClosed({ ref: 1 });
    events.frame({ direction: 'in', type: 'input_audio_buffer.speech_stopped', payload: { itemId: 'heard', audioEndMs: 1800 } });
    const diagnostics = getFaceToFaceDiagnostics();
    expect(diagnostics?.providerConnections).toBe(1);
    expect(diagnostics?.fixtureSpeakerTurns).toEqual([{
      itemId: 'heard', connection: 1, providerSpeaker: 7, startMs: 650, endMs: 1800, appSpeaker: 1, hasSource: true, final: true,
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain('これは試験です');
    await close();
  });

  it('starts the reverse Qwen session only for a missing subtitle and passes exactly that item audio', async () => {
    const primary = fakeSession();
    const secondary = fakeSession();
    const pcm = new Int16Array(24_000).map((_, index) => index);
    let primaryEvents!: AdapterEvents;
    let primaryConfig!: QwenConfig;
    mocks.openSource.mockResolvedValue(fakeSource());
    mocks.startQwen
      .mockImplementationOnce(async (request: { config: QwenConfig }, events: AdapterEvents) => {
        primaryEvents = events;
        primaryConfig = request.config;
        return primary;
      })
      .mockImplementationOnce(async (_request: unknown, events: AdapterEvents) => {
        secondary.endTurn.mockImplementation(() => {
          events.segmentOpened({ ref: 10, side: 'translation' });
          events.segmentText({ ref: 10, text: '午後三時に会いましょう。' });
          events.segmentClosed({ ref: 10 });
          events.frame({ direction: 'in', type: 'response.done', payload: { status: 'completed' } });
        });
        return secondary;
      });
    const close = await startFaceToFaceRuntime();
    expect(primaryConfig.activity).toBe('face-to-face');
    expect(primaryConfig.sourceLanguageHints).toEqual(['zh', 'ja']);
    const turnAudio = primaryConfig.turnAudio!;
    turnAudio.append(pcm);
    primaryEvents.segmentOpened({ ref: 1, side: 'source', origin: 'japanese', person: 'j' });
    primaryEvents.segmentText({ ref: 1, text: 'こんにちは。', language: 'ja' });
    primaryEvents.segmentClosed({ ref: 1 });
    expect(mocks.startQwen).toHaveBeenCalledTimes(1);

    turnAudio.speechStarted('chinese', 200);
    primaryEvents.segmentOpened({ ref: 2, side: 'source', origin: 'chinese', person: 'c' });
    primaryEvents.segmentText({ ref: 2, text: '我们下午三点见。', language: 'zh' });
    primaryEvents.segmentClosed({ ref: 2 });
    turnAudio.speechStopped('chinese', 800);

    await vi.waitFor(() => expect(useFaceToFaceStore.getState().captions[1].subtitles).toEqual({
      zh: '我们下午三点见。', ja: '午後三時に会いましょう。',
    }));
    expect(mocks.startQwen.mock.calls[1][0]).toMatchObject({ context: { direction: { target: 'ja' }, turns: 'manual', speech: false }, config: { activity: 'face-to-face' } });
    const chunks = secondary.appendAudio.mock.calls.map(([chunk]) => chunk as Int16Array);
    expect(chunks.every((chunk) => chunk.length <= 2_400)).toBe(true);
    expect(Int16Array.from(chunks.flatMap((chunk) => Array.from(chunk)))).toEqual(pcm.slice(4_800, 19_200));
    await close();
    expect(mocks.sessionStop).toHaveBeenCalledTimes(2);
  });

  it('streams each missing Qwen target when the third subtitle is selected', async () => {
    let primaryEvents!: AdapterEvents;
    let primaryConfig!: QwenConfig;
    useFaceToFaceStore.setState({ languages: { first: 'zh', second: 'ja', third: 'en' } });
    mocks.startQwen
      .mockImplementationOnce(async ({ config }: { config: QwenConfig }, events: AdapterEvents) => {
        primaryEvents = events;
        primaryConfig = config;
        return fakeSession();
      })
      .mockImplementation(async ({ context }, events: AdapterEvents) => {
        const translation = context.direction.target === 'ja' ? 'おはようございます。' : 'Good morning.';
        const replay = fakeSession();
        replay.endTurn.mockImplementation(() => {
          events.segmentOpened({ ref: 10, side: 'translation' });
          events.segmentText({ ref: 10, text: translation });
          events.segmentClosed({ ref: 10 });
          events.frame({ direction: 'in', type: 'response.done', payload: { status: 'completed' } });
        });
        return replay;
      });
    const close = await startFaceToFaceRuntime(undefined, async () => fakeSource());
    const turnAudio = primaryConfig.turnAudio!;
    turnAudio.append(new Int16Array(24_000).fill(300));
    turnAudio.speechStarted('triple', 0);
    primaryEvents.segmentOpened({ ref: 1, side: 'source', origin: 'triple' });
    primaryEvents.segmentText({ ref: 1, text: '早上好。', language: 'zh' });
    turnAudio.speechStopped('triple', 900);
    primaryEvents.segmentClosed({ ref: 1 });
    await vi.waitFor(() => expect(useFaceToFaceStore.getState().captions[0].subtitles).toEqual({
      zh: '早上好。', ja: 'おはようございます。', en: 'Good morning.',
    }));
    expect(mocks.startQwen.mock.calls.map(([request]) => request.context.direction.target)).toEqual(['zh', 'ja', 'en']);
    await close();
    mocks.startQwen.mockReset();
  });

  it('starts OpenAI Translate with the first selected target, uses the shared key, and fans finalized text out to the other language', async () => {
    let events!: AdapterEvents;
    mocks.startOpenai.mockImplementation(async (request: { context: unknown; config: unknown; credentials: unknown }, adapterEvents: AdapterEvents) => {
      events = adapterEvents;
      expect(request).toMatchObject({
        context: { direction: { source: 'zh', target: 'zh' }, speech: false, turns: 'auto' },
        config: { target: 'zh', detectParticipantLanguage: true },
        credentials: { apiKey: 'shared-openai-key' },
      });
      return fakeSession();
    });
    mocks.translateCaption.mockImplementation(({ targetLanguage }: { targetLanguage: string }) =>
      Promise.resolve(targetLanguage === 'ja' ? '日本語の訳。' : 'English translation.'));
    mocks.openSource.mockResolvedValue(fakeSource());
    useProviderStore.setState({
      entries: { openai_translate: { settings: TRANSLATE_DEFAULTS, credentials: { apiKey: ' shared-openai-key ' } } as never },
    });
    useLineUpStore.setState({ lineUp: { transcription: 'openai_translate', translation: 'openai_translate', speech: 'openai_translate', summarisation: null }, stored: true });
    useFaceToFaceStore.setState({ languages: { first: 'zh', second: 'ja', third: 'en' } });

    const close = await startFaceToFaceRuntime();
    expect(mocks.startOpenai).toHaveBeenCalledTimes(1);
    expect(mocks.startQwen).not.toHaveBeenCalled();
    expect(mocks.micSettings.mock.calls[0][0].muted()).toBe(false);

    events.segmentOpened({ ref: 1, side: 'source', origin: 'turn-1' });
    events.segmentText({ ref: 1, text: 'Bonjour.', language: 'fr' });
    events.segmentClosed({ ref: 1 });
    events.segmentOpened({ ref: 2, side: 'translation', origin: 'turn-1' });
    events.segmentText({ ref: 2, text: '早上好。', language: 'zh' });

    await vi.waitFor(() => expect(useFaceToFaceStore.getState().captions[0].subtitles).toEqual({
      zh: '早上好。', ja: '日本語の訳。', en: 'English translation.',
    }));
    expect(mocks.translateCaption).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Bonjour.', sourceLanguage: 'fr', targetLanguage: 'ja', apiKey: 'shared-openai-key',
    }));
    expect(mocks.translateCaption.mock.calls.map(([request]) => (request as { targetLanguage: string }).targetLanguage).sort()).toEqual(['en', 'ja']);
    await close();
  });

  it.each([
    {
      name: 'shared Bailian ignores a blank stale workspace key',
      connection: BAILIAN_ENDPOINT_ID,
      stored: { apiKey: 'shared-bailian-key', workspaceApiKey: '  \n' },
      expected: { apiKey: 'shared-bailian-key' },
    },
    {
      name: 'workspace Bailian uses its configured key when a shared key is stored',
      connection: BAILIAN_WORKSPACE_CONNECTION,
      stored: { apiKey: 'stale-shared-key', workspaceApiKey: ' workspace-bailian-key\n' },
      expected: { apiKey: 'workspace-bailian-key' },
    },
  ])('reads credentials correctly: $name', async ({ connection, stored, expected }) => {
    mocks.startQwen.mockResolvedValue(fakeSession());
    mocks.openSource.mockResolvedValue(fakeSource());
    useProviderStore.setState({
      entries: {
        qwen_livetranslate: {
          settings: { ...QWEN_DEFAULTS, connection, workspaceId: 'llm-test' },
          credentials: stored,
        } as never,
      },
    });
    const controller = new AbortController();

    const close = await startFaceToFaceRuntime(controller.signal);

    expect(mocks.startQwen).toHaveBeenCalledTimes(1);
    expect(mocks.startQwen.mock.calls[0][0]).toMatchObject({ credentials: expected });
    await close();
  });

  it('preserves a provider open failure after cleanup', async () => {
    const failure = new Error('Qwen websocket could not be opened.');
    mocks.startQwen.mockRejectedValue(failure);
    const controller = new AbortController();

    await expect(startFaceToFaceRuntime(controller.signal)).rejects.toBe(failure);

    expect(useFaceToFaceStore.getState().phase).toBe('error');
    expect(useFaceToFaceStore.getState().error).toBe(failure.message);
    expect(mocks.openSource).not.toHaveBeenCalled();
    expect(mocks.sessionStop).not.toHaveBeenCalled();
    expect(mocks.sourceStop).not.toHaveBeenCalled();
  });

  it('preserves a microphone open failure after releasing the opened provider session', async () => {
    const failure = new Error('Microphone permission was denied.');
    mocks.startQwen.mockResolvedValue(fakeSession());
    mocks.openSource.mockRejectedValue(failure);
    const controller = new AbortController();

    await expect(startFaceToFaceRuntime(controller.signal)).rejects.toBe(failure);

    expect(useFaceToFaceStore.getState().phase).toBe('error');
    expect(useFaceToFaceStore.getState().error).toBe(failure.message);
    expect(mocks.openSource).toHaveBeenCalledTimes(1);
    expect(mocks.sessionStop).toHaveBeenCalledTimes(1);
    expect(mocks.sourceStop).not.toHaveBeenCalled();
  });

  it('holds the stopping state until an in-flight Qwen open has unwound and stops that socket without opening a mic', async () => {
    let resolveSession!: (session: ReturnType<typeof fakeSession>) => void;
    mocks.startQwen.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
    const controller = new AbortController();
    const opening = startFaceToFaceRuntime(controller.signal);
    await vi.waitFor(() => expect(mocks.startQwen).toHaveBeenCalledTimes(1));

    const stopping = stopFaceToFaceRuntime();
    expect(useFaceToFaceStore.getState().phase).toBe('stopping');
    resolveSession(fakeSession());
    await stopping;
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.sessionStop).toHaveBeenCalledTimes(1);
    expect(mocks.openSource).not.toHaveBeenCalled();
    expect(useFaceToFaceStore.getState().phase, useFaceToFaceStore.getState().error ?? '').toBe('idle');
  });

  it('keeps mode stopping until both the Qwen session and microphone source release', async () => {
    mocks.startQwen.mockResolvedValue(fakeSession());
    const source = fakeSource();
    mocks.openSource.mockResolvedValue(source);
    const controller = new AbortController();
    const close = await startFaceToFaceRuntime(controller.signal);
    expect(useFaceToFaceStore.getState().phase).toBe('live');
    expect(mocks.openSource).toHaveBeenCalledTimes(1);

    let finishSourceStop!: () => void;
    mocks.sourceStop.mockImplementation(() => new Promise<void>((resolve) => { finishSourceStop = resolve; }));
    const stopping = close();
    expect(useFaceToFaceStore.getState().phase).toBe('stopping');
    await vi.waitFor(() => expect(mocks.sessionStop).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(source.stop).toHaveBeenCalledTimes(1));
    finishSourceStop();
    await stopping;
    expect(useFaceToFaceStore.getState().phase).toBe('idle');
  });
});
