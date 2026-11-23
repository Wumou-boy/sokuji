import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAgentControl } from './agentControl';
import type { AppSession } from './session';
import useAudioStore from '../stores/audioStore';
import { useLineUpStore } from '../stores/lineUpStore';
import { useProviderStore } from '../stores/providerStore';
import { useRoutingStore } from '../stores/routingStore';
import { useSettingsStore } from '../stores/settingsStore';
import useLogStore from '../stores/logStore';

const mockProviders = vi.hoisted(() => [{ id: 'openai' }, { id: 'qwen_livetranslate' }, { id: 'openai_translate' }]);
vi.mock('../providers/registry', () => ({ presentProviders: () => mockProviders }));

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
  routing: useRoutingStore.getState(),
  settings: useSettingsStore.getState(),
  logs: useLogStore.getState(),
};

afterEach(() => {
  vi.restoreAllMocks();
  useAudioStore.setState(initial.audio, true);
  useProviderStore.setState(initial.provider, true);
  useLineUpStore.setState(initial.lineUp, true);
  useRoutingStore.setState(initial.routing, true);
  useSettingsStore.setState(initial.settings, true);
  useLogStore.setState(initial.logs, true);
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

  it('reports credential presence as booleans only', async () => {
    const { handler, replies, detach } = setup();
    const store = useProviderStore.getState();
    const load = vi.spyOn(store, 'load').mockResolvedValue();
    useProviderStore.setState({ entries: {
      openai: { settings: {}, credentials: { apiKey: 'synthetic-openai-key' }, pair: { source: 'ja', target: 'en' } },
      qwen_livetranslate: { settings: {}, credentials: { apiKey: '' }, pair: { source: 'ja', target: 'en' } },
    } as never });

    handler({ id: 'credentials', command: 'credentials.status', args: {} });
    await vi.waitFor(() => expect(replies.some((item) => item.id === 'credentials')).toBe(true));

    expect(dataOf(replyFor(replies, 'credentials'))).toEqual({ openaiConfigured: true, qwenConfigured: false });
    expect(load).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(replyFor(replies, 'credentials'))).not.toContain('synthetic-openai-key');
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
