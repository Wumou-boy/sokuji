import { abortError } from './chat';

export { notesEndpointOf } from './notesEndpoint';

type Result =
  | { ok: false; code: string }
  | { ok: true; status: number; body: string; requestId?: string };

/** Send a compatible notes request through the trusted desktop page's main process. */
export function makeNotesFetch(): typeof fetch {
  return async (input, init) => {
    const bridge = typeof window === 'undefined' ? undefined : window.electron;
    if (!bridge?.invoke || typeof input !== 'string' || init?.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error('Compatible notes require the Sokuji desktop app.');
    }
    const signal = init.signal;
    if (signal?.aborted) throw abortError();
    const id = crypto.randomUUID();
    const authorization = new Headers(init.headers).get('authorization') ?? undefined;
    const pending: Promise<Result> = bridge.invoke('notes-http:complete', { id, url: input, body: init.body, authorization });
    let onAbort: (() => void) | undefined;
    try {
      const result = await (signal ? Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            void bridge.invoke('notes-http:abort', { id }).catch(() => {});
            reject(abortError());
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]) : pending);
      if (!result?.ok) {
        if (result?.code === 'invalid') throw new Error('Invalid notes endpoint or request.');
        if (result?.code === 'timeout') throw new Error('The notes model took too long to respond.');
        throw new Error('Could not reach the configured notes model.');
      }
      const noBody = result.status === 204 || result.status === 205 || result.status === 304;
      return new Response(noBody ? null : result.body, {
        status: result.status,
        headers: result.requestId ? { 'x-request-id': result.requestId } : undefined,
      });
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}
