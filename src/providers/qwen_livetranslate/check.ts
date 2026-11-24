/**
 * Qwen LiveTranslate's readiness and region (spec 2026-10-13, §2): the
 * key is asked for a one-minute token at each region's endpoint in turn. A
 * 200 names the endpoint — the token is never read: it expires on its own,
 * opens no session and costs nothing. A 401 or 403 moves on; refused by
 * both is `auth`, a 429 is `rate_limit`, and anything else throws: the check
 * could not tell. HTTPS, not the socket: a browser hides a refused upgrade's
 * status. CORS answers any origin, the extension's and `file://` included
 * (probe 2026-10-13). The settings side; the adapter runs `detectEndpoint`
 * only when its config names no endpoint, handed in as a dependency, on
 * the request's clock and signal.
 */
import { realClock, type Clock } from '../../lib/contract/clock';
import { platformHeaderSocket, type OpenHeaderSocket } from '../../lib/contract/headerSocket';
import { boundedFetch } from '../../lib/provider/boundedFetch';
import type { CheckContext, CheckResult } from '../../lib/provider/types';
import { BAILIAN_ENDPOINT_ID, ENDPOINT_ORDER, ENDPOINTS, type EndpointId } from './endpoints';
import { QWEN_REGION_LABELS } from './regions';
import { qwenHeaders } from './wire';
import { QWEN_MODEL, type QwenCredentials, type QwenSettings } from './settings';
import { BAILIAN_WORKSPACE_CONNECTION, bailianWorkspaceSocketUrl, normalizeBailianWorkspaceId } from './endpoints';
import { isBailianWorkspaceAvailable } from './workspace';

/** As long as the other checks wait, per endpoint. */
export const DETECT_TIMEOUT_MS = 15_000;

export interface DetectDeps {
  fetch?: typeof fetch;
  clock?: Pick<Clock, 'setTimeout'>;
  signal?: AbortSignal;
  openHeaderSocket?: OpenHeaderSocket;
  workspaceSupported?: () => boolean;
}

export type Detection = { endpoint: EndpointId } | { refused: string; code: string };
export type DetectEndpoint = (apiKey: string, o: DetectDeps) => Promise<Detection>;

/** Readiness probe for a Bailian key: authenticate the real Realtime host and validate a zero-audio, text-only session update. */
export async function checkBailianEndpoint(apiKey: string, o: DetectDeps): Promise<Detection> {
  return checkBailianSocket(apiKey, `${ENDPOINTS[BAILIAN_ENDPOINT_ID].socket}?model=${encodeURIComponent(QWEN_MODEL)}`, false, o);
}

export async function checkBailianWorkspaceEndpoint(apiKey: string, workspaceId: string, o: DetectDeps): Promise<Detection> {
  const normalized = normalizeBailianWorkspaceId(workspaceId);
  if (!normalized) return { refused: 'Enter a valid Bailian workspace ID.', code: 'client' };
  if (!(o.workspaceSupported ?? isBailianWorkspaceAvailable)()) {
    return { refused: 'Bailian workspace connections are available in the Windows desktop app only.', code: 'client' };
  }
  return checkBailianSocket(apiKey, bailianWorkspaceSocketUrl(normalized, QWEN_MODEL), true, o);
}

async function checkBailianSocket(apiKey: string, url: string, exactPath: boolean, o: DetectDeps): Promise<Detection> {
  const openHeaderSocket = o.openHeaderSocket;
  if (!openHeaderSocket) return { refused: 'Bailian Realtime checks require the desktop app or browser extension.', code: 'client' };
  const clock = o.clock ?? realClock;
  const controller = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
  let socket: WebSocket | null = null;
  let cancelTimeout = () => {};
  let settled = false;
  let onAbort = () => {};

  return new Promise<Detection>((resolve) => {
    const finish = (result: Detection) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      signal.removeEventListener('abort', onAbort);
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState <= WebSocket.OPEN) socket.close(1000);
      }
      resolve(result);
    };
    cancelTimeout = clock.setTimeout(() => {
      controller.abort(new Error('Bailian Realtime readiness check timed out.'));
      finish({ refused: 'Bailian Realtime did not confirm a session in time.', code: 'network' });
    }, DETECT_TIMEOUT_MS);
    if (signal.aborted) {
      finish({ refused: 'Bailian Realtime readiness check was cancelled.', code: 'network' });
      return;
    }
    onAbort = () => finish({ refused: 'Bailian Realtime readiness check was cancelled.', code: 'network' });
    signal.addEventListener('abort', onAbort, { once: true });
    void openHeaderSocket(url, qwenHeaders({ apiKey }, exactPath), { signal, clock })
      .then((opened) => {
        socket = opened;
        if (settled) {
          opened.close(1000);
          return;
        }
        opened.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as { type?: unknown; error?: { code?: unknown } };
            if (event.type === 'session.created') {
              opened.send(JSON.stringify({
                type: 'session.update',
                session: {
                  output_modalities: ['text'],
                  translation: { language: 'zh' },
                  audio: { input: { format: { type: 'pcm', sample_rate: 16000 } } },
                },
              }));
            } else if (event.type === 'session.updated') {
              finish({ endpoint: BAILIAN_ENDPOINT_ID });
            } else if (event.type === 'error') {
              const code = typeof event.error?.code === 'string' ? event.error.code : '';
              const category = /quota|throttl|rate.?limit/i.test(code) ? 'rate_limit' : /InvalidApiKey|InvalidApiToken|expired|AccessDenied/i.test(code) ? 'auth' : 'model_access_denied';
              finish({ refused: 'Bailian did not accept this API key or Qwen LiveTranslate session configuration.', code: category });
            }
          } catch {
            finish({ refused: 'Bailian returned an unreadable readiness response.', code: 'network' });
          }
        };
        opened.onerror = () => finish({ refused: 'Could not reach the Bailian Realtime endpoint.', code: 'network' });
        opened.onclose = () => finish({ refused: 'Bailian closed the Realtime readiness connection.', code: 'network' });
      })
      .catch(() => finish({ refused: 'Bailian did not accept the WebSocket authentication or could not be reached.', code: 'auth' }));
  });
}

export const detectEndpoint: DetectEndpoint = async (apiKey, o) => {
  // Read at call time, so a test's stubbed global is seen.
  const doFetch = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const clock = o.clock ?? realClock;
  const late = `Qwen did not answer the key check within ${DETECT_TIMEOUT_MS / 1000} s.`;
  let status = 0;
  for (const id of ENDPOINT_ORDER) {
    status = await boundedFetch({ clock, ms: DETECT_TIMEOUT_MS, signal: o.signal, late }, async (signal) => {
      const response = await doFetch(`${ENDPOINTS[id].tokens}?expire_in_seconds=60`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal });
      return response.status;
    });
    if (status === 200) return { endpoint: id };
    if (status === 429) return { refused: `Qwen's ${QWEN_REGION_LABELS[ENDPOINTS[id].region]} region is limiting requests (HTTP 429).`, code: 'rate_limit' };
    if (status !== 401 && status !== 403) throw new Error(`Qwen answered the key check with HTTP ${status}.`);
  }
  return { refused: `Neither Qwen's ${QWEN_REGION_LABELS.sg} nor its ${QWEN_REGION_LABELS.cn} region accepted this key (HTTP ${status}).`, code: 'auth' };
};

export function createQwenCheck(deps: Omit<DetectDeps, 'signal'> = {}) {
  return async (k: QwenCredentials, s: QwenSettings, ctx: CheckContext): Promise<CheckResult> => {
    if (s.connection === BAILIAN_WORKSPACE_CONNECTION) {
      const found = await checkBailianWorkspaceEndpoint(k.apiKey, s.workspaceId, { ...deps, signal: ctx.signal });
      return 'endpoint' in found ? { ok: true, models: [{ id: BAILIAN_WORKSPACE_CONNECTION }] } : { ok: false, reason: found.refused, code: found.code };
    }
    if (s.connection === BAILIAN_ENDPOINT_ID) {
      const found = await checkBailianEndpoint(k.apiKey, { ...deps, signal: ctx.signal });
      return 'endpoint' in found ? { ok: true, models: [{ id: found.endpoint }] } : { ok: false, reason: found.refused, code: found.code };
    }
    const found = await detectEndpoint(k.apiKey, { ...deps, signal: ctx.signal });
    // The one model entry names the endpoint: `build` reads it from `shared.models`, the settings view from `models`.
    return 'endpoint' in found ? { ok: true, models: [{ id: found.endpoint }] } : { ok: false, reason: found.refused, code: found.code };
  };
}

export const checkQwen = createQwenCheck({ openHeaderSocket: platformHeaderSocket });
