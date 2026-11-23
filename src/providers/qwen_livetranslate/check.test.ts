import { describe, it, expect, vi } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import type { CheckContext } from '../../lib/provider/types';
import { createQwenCheck, checkBailianEndpoint, DETECT_TIMEOUT_MS, detectEndpoint } from './check';
import { BAILIAN_ENDPOINT_ID, ENDPOINTS, isEndpointId } from './endpoints';
import { QWEN_DEFAULTS } from './settings';
import { FakeSocket } from '../../lib/contract/testing/fakeSocket';

const K = { apiKey: 'sk-ws-T.ABCDEFGH.ijklmnop.QRSTUVWX0123456789' };
const ctx: CheckContext = { pair: { source: 'zh', target: 'en' }, legs: ['speaker'] };
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const refused = () => answer(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' });
const check = (fetch: typeof globalThis.fetch, c: CheckContext = ctx) => createQwenCheck({ fetch, clock: createVirtualClock(0) })(K, QWEN_DEFAULTS, c);
const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((call) => (call as unknown as [string])[0]);

describe("Qwen LiveTranslate's endpoints", () => {
  it('are a Singapore host and a Beijing host, each a socket and a token endpoint', () => {
    expect(ENDPOINTS).toEqual({
      intl: { region: 'sg', socket: 'wss://maas.qwencloudapi.com/api-ws/v1/realtime', tokens: 'https://maas.qwencloudapi.com/api/v1/tokens' },
      cn: { region: 'cn', socket: 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime', tokens: 'https://maas.qianwenaiapi.com/api/v1/tokens' },
      'bailian-cn': { region: 'cn', socket: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' },
    });
    expect(isEndpointId('intl')).toBe(true);
    expect(isEndpointId('cn')).toBe(true);
    expect(isEndpointId('bailian-cn')).toBe(true);
    expect(isEndpointId('gpt-live-1')).toBe(false);
  });

  it('checks an explicit Bailian key against the shared WSS host, authenticates in the header, validates a text-only zh session, and closes', async () => {
    const socket = new FakeSocket('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime', undefined);
    socket.open();
    const openHeaderSocket = vi.fn(async () => socket as unknown as WebSocket);
    const fetch = vi.fn(async () => { throw new Error('must not use QwenCloud token endpoint'); });
    const pending = createQwenCheck({ fetch, openHeaderSocket })(K, { ...QWEN_DEFAULTS, connection: BAILIAN_ENDPOINT_ID }, ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(openHeaderSocket).toHaveBeenCalledWith(
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
      { set: { Authorization: `Bearer ${K.apiKey}` } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    socket.receive(JSON.stringify({ type: 'session.created' }));
    expect(socket.sent.map((frame) => JSON.parse(String(frame)))).toEqual([{
      type: 'session.update', session: {
        output_modalities: ['text'], translation: { language: 'zh' },
        audio: { input: { format: { type: 'pcm', sample_rate: 16000 } } },
      },
    }]);
    socket.receive(JSON.stringify({ type: 'session.updated' }));
    await expect(pending).resolves.toEqual({ ok: true, models: [{ id: 'bailian-cn' }] });
    expect(fetch).not.toHaveBeenCalled();
    expect(socket.closedByClient).toEqual({ code: 1000, reason: undefined });
  });

  it('keeps auto connection checks on the legacy QwenCloud token endpoints', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(refused()).mockResolvedValueOnce(answer(200));
    const openHeaderSocket = vi.fn();
    await expect(createQwenCheck({ fetch, openHeaderSocket })(K, QWEN_DEFAULTS, ctx)).resolves.toMatchObject({
      ok: true, models: [{ id: 'cn' }],
    });
    expect(openHeaderSocket).not.toHaveBeenCalled();
  });
});

describe("Qwen LiveTranslate's check (spec §2)", () => {
  it("a key the Singapore host mints a token for is Singapore's: one POST, the key in the header alone, the token never read", async () => {
    const fetch = vi.fn(async () => answer(200, { token: 'st-unread', expires_at: 1 }));
    await expect(check(fetch)).resolves.toEqual({ ok: true, models: [{ id: 'intl' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://maas.qwencloudapi.com/api/v1/tokens?expire_in_seconds=60');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: `Bearer ${K.apiKey}` } });
  });

  it("a key Singapore refuses and Beijing accepts is Beijing's", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(refused()).mockResolvedValueOnce(answer(200, { token: 'st-unread' }));
    await expect(check(fetch)).resolves.toEqual({ ok: true, models: [{ id: 'cn' }] });
    expect(urls(fetch)).toEqual(['https://maas.qwencloudapi.com/api/v1/tokens?expire_in_seconds=60', 'https://maas.qianwenaiapi.com/api/v1/tokens?expire_in_seconds=60']);
  });

  it('a key both refuse — 401 or 403 — is not ready, as auth', async () => {
    await expect(check(vi.fn(async () => refused()))).resolves.toEqual({ ok: false, code: 'auth', reason: "Neither Qwen's Singapore nor its 北京 (Beijing) region accepted this key (HTTP 401)." });
    await expect(check(vi.fn().mockResolvedValueOnce(answer(403)).mockResolvedValueOnce(refused()))).resolves.toMatchObject({ ok: false, code: 'auth' });
  });

  it('a rate limit is not ready, as rate_limit, and the other region is not asked', async () => {
    const fetch = vi.fn(async () => answer(429));
    await expect(check(fetch)).resolves.toEqual({ ok: false, code: 'rate_limit', reason: "Qwen's Singapore region is limiting requests (HTTP 429)." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a status the key does not explain, or a failed request, cannot tell: it throws', async () => {
    await expect(check(vi.fn(async () => answer(500)))).rejects.toThrow('Qwen answered the key check with HTTP 500.');
    await expect(check(vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).rejects.toThrow('Failed to fetch');
  });

  it(`no answer within ${DETECT_TIMEOUT_MS / 1000} s throws in words, the request aborted`, async () => {
    const clock = createVirtualClock(0);
    let aborted = false;
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    }));
    const pending = createQwenCheck({ fetch: fetch as unknown as typeof globalThis.fetch, clock })(K, QWEN_DEFAULTS, ctx);
    clock.advance(DETECT_TIMEOUT_MS);
    await expect(pending).rejects.toThrow(`Qwen did not answer the key check within ${DETECT_TIMEOUT_MS / 1000} s.`);
    expect(aborted).toBe(true);
  });

  it("a check its caller aborts throws the caller's reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(check(vi.fn(async () => answer(200)), { ...ctx, signal: controller.signal })).rejects.toThrow('stopped');
  });

  it('detection alone answers the endpoint or the refusal, for the adapter to use', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(refused()).mockResolvedValueOnce(answer(200));
    await expect(detectEndpoint(K.apiKey, { fetch, clock: createVirtualClock(0) })).resolves.toEqual({ endpoint: 'cn' });
    await expect(detectEndpoint(K.apiKey, { fetch: vi.fn(async () => refused()), clock: createVirtualClock(0) }))
      .resolves.toEqual({ refused: "Neither Qwen's Singapore nor its 北京 (Beijing) region accepted this key (HTTP 401).", code: 'auth' });
  });
});
