import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startQwen: vi.fn(),
  openSource: vi.fn(),
  sessionStop: vi.fn(async () => {}),
  sourceStop: vi.fn(async () => {}),
}));

vi.mock('../../providers/qwen_livetranslate/provider', async () => {
  const { qwenCredentials } = await import('../../providers/qwen_livetranslate/settings');
  return {
    qwenLiveTranslateProvider: {
      credentials: qwenCredentials,
      units: [{ start: (...args: unknown[]) => mocks.startQwen(...args) }],
    },
  };
});
vi.mock('../../app/session', () => ({
  getAppSession: () => ({ audio: async () => ({ capture: { openSource: (...args: unknown[]) => mocks.openSource(...args) } }) }),
}));

import { startFaceToFaceRuntime, stopFaceToFaceRuntime } from './runtime';
import { QWEN_DEFAULTS } from '../../providers/qwen_livetranslate/settings';
import { BAILIAN_ENDPOINT_ID, BAILIAN_WORKSPACE_CONNECTION } from '../../providers/qwen_livetranslate/endpoints';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { useProviderStore } from '../../stores/providerStore';
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
  useFaceToFaceStore.setState({ mode: 'face-to-face', phase: 'starting', error: null, languages: { first: 'zh', second: 'ja' }, captions: [] });
});

afterEach(async () => {
  await stopFaceToFaceRuntime();
  useFaceToFaceStore.setState({ mode: 'meeting', phase: 'idle', error: null, languages: { first: 'zh', second: 'ja' }, captions: [] });
  useProviderStore.setState({ entries: {} });
});

describe('face-to-face runtime ownership', () => {
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
    expect(mocks.startQwen.mock.calls[1][0]).toMatchObject({ context: { direction: { target: 'ja' }, turns: 'manual', speech: false } });
    const chunks = secondary.appendAudio.mock.calls.map(([chunk]) => chunk as Int16Array);
    expect(chunks.every((chunk) => chunk.length <= 2_400)).toBe(true);
    expect(Int16Array.from(chunks.flatMap((chunk) => Array.from(chunk)))).toEqual(pcm.slice(4_800, 19_200));
    await close();
    expect(mocks.sessionStop).toHaveBeenCalledTimes(2);
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
