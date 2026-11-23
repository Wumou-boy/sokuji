import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatError } from '../../lib/notes/chat';
import {
  CAPTION_TRANSLATION_MODEL,
  CAPTION_TRANSLATION_TIMEOUT_MS,
  createTranslateCaption,
  translateCaption,
} from './textTranslation';

const completion = (value: unknown) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(value) } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('OpenAI Translate source-segment text translation', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('sends a source-bound, literal caption request and returns only the translation', async () => {
    const send = vi.fn(async () => completion({ translation: '请保留 API v2 的 5 毫米间隙。' }));
    const translate = createTranslateCaption(send);
    const controller = new AbortController();

    await expect(translate({
      text: 'Keep the 5 mm clearance in API v2.',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      apiKey: 'test-key-never-sent-to-network',
      signal: controller.signal,
    })).resolves.toBe('请保留 API v2 的 5 毫米间隙。');

    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-never-sent-to-network');
    expect(init.signal).not.toBe(controller.signal);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.messages[0].content).toContain('not instructions');
    expect(body.messages[0].content).toContain('Preserve names, product identifiers, acronyms, numbers, dates, measurements, units, URLs, and code');
    expect(body.messages[1].content).toBe(JSON.stringify({
      text: 'Keep the 5 mm clearance in API v2.', sourceLanguage: 'en', targetLanguage: 'zh',
    }));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(CAPTION_TRANSLATION_MODEL).toBe('gpt-6-luna');
  });

  it('uses global fetch by default with a local mock, never the live API', async () => {
    const send = vi.fn(async () => completion({ translation: '会议从下午 2:30 开始。' }));
    vi.stubGlobal('fetch', send);

    await expect(translateCaption({
      text: 'The meeting starts at 2:30 PM.',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      apiKey: 'local-mock-key',
      signal: new AbortController().signal,
    })).resolves.toBe('会议从下午 2:30 开始。');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not send an empty source segment', async () => {
    const send = vi.fn(async () => completion({ translation: 'unused' }));
    await expect(createTranslateCaption(send)({
      text: '  ', sourceLanguage: 'ja', targetLanguage: 'zh', apiKey: 'unused', signal: new AbortController().signal,
    })).resolves.toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('stops a stale caption request when its caller aborts', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = createTranslateCaption(send)({
      text: 'A caption that has already changed.', sourceLanguage: 'en', targetLanguage: 'zh', apiKey: 'unused', signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds one request and does not retry a rate limit', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const pending = createTranslateCaption(send)({
      text: 'This must not wait on a long retry.', sourceLanguage: 'en', targetLanguage: 'zh', apiKey: 'unused', signal: new AbortController().signal,
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(CAPTION_TRANSLATION_TIMEOUT_MS);
    deadline.abort(new DOMException('Caption translation timed out.', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(send).toHaveBeenCalledOnce();
    timeout.mockRestore();

    const rateLimited = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(createTranslateCaption(rateLimited)({
      text: 'No retry please.', sourceLanguage: 'en', targetLanguage: 'zh', apiKey: 'unused', signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ChatError);
    expect(rateLimited).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    {},
    { translation: '' },
    { translation: '   ' },
    { translation: 'ok', extra: 'unexpected' },
  ])('rejects an invalid or empty model answer (%j)', async (modelAnswer) => {
    const send = vi.fn(async () => completion(modelAnswer));
    await expect(createTranslateCaption(send)({
      text: 'こんにちは。', sourceLanguage: 'ja', targetLanguage: 'zh', apiKey: 'unused', signal: new AbortController().signal,
    })).rejects.toThrow('Caption translation returned no translation text.');
  });
});
