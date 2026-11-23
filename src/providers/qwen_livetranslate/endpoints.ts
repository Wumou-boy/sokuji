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

export function isEndpointId(v: unknown): v is EndpointId {
  return v === 'intl' || v === 'cn' || v === BAILIAN_ENDPOINT_ID;
}
