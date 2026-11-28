import type { QwenRegion } from './regions';

/**
 * Qwen LiveTranslate endpoints: QwenCloud Singapore and Beijing, plus
 * Alibaba Bailian's legacy Beijing shared DashScope host. A key belongs to
 * the region it was made in, whichever console made it — QwenCloud's or
 * 千问云's — and the other region answers 401 (probe 2026-10-23). The check
 * finds which; nothing else chooses. Pure data, read by the adapter, the
 * check and the settings view. The ids are the managed grant's words.
 */
export const ENDPOINTS = {
  intl: { region: 'sg', socket: 'wss://maas.qwencloudapi.com/api-ws/v1/realtime', tokens: 'https://maas.qwencloudapi.com/api/v1/tokens' },
  cn: { region: 'cn', socket: 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime', tokens: 'https://maas.qianwenaiapi.com/api/v1/tokens' },
  'bailian-cn': { region: 'cn', socket: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' },
} as const satisfies Record<string, { region: QwenRegion; socket: string; tokens?: string }>;

export type EndpointId = keyof typeof ENDPOINTS;

/** The order detection asks them in: Singapore first. */
export const ENDPOINT_ORDER = ['intl', 'cn'] as const;
export const BAILIAN_ENDPOINT_ID = 'bailian-cn' as const;
export const BAILIAN_WORKSPACE_CONNECTION = 'bailian-workspace' as const;
const BAILIAN_BEIJING_WORKSPACE_SUFFIX = '.cn-beijing.maas.aliyuncs.com';

/** Bailian Workspace IDs occupy exactly one DNS label in the Beijing hostname. */
export function normalizeBailianWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!/^llm-[a-z0-9]{1,59}$/i.test(id)) return null;
  return id.toLowerCase();
}

/** The only endpoint accepted for a dedicated company workspace. */
function bailianWorkspaceHost(value: unknown): string | null {
  const id = normalizeBailianWorkspaceId(value);
  return id ? `${id}${BAILIAN_BEIJING_WORKSPACE_SUFFIX}` : null;
}

export function bailianWorkspaceNotesBaseUrl(value: unknown): string | null {
  const host = bailianWorkspaceHost(value);
  return host ? `https://${host}/compatible-mode/v1` : null;
}

/** The model is fixed by Sokuji; callers cannot supply a host, path or query. */
export function bailianWorkspaceSocketUrl(value: unknown, model: string): string {
  const host = bailianWorkspaceHost(value);
  if (!host) throw new Error('Enter a valid Bailian workspace ID.');
  return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}


export function isEndpointId(v: unknown): v is EndpointId {
  return v === 'intl' || v === 'cn' || v === BAILIAN_ENDPOINT_ID;
}
