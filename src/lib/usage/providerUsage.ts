import { recordUsage, type UsageActivity, type UsageDelta } from './ledger';
import { recordHistoryNotes } from './sessionTokens';

export const LIVE_TRANSLATE_MODEL = 'qwen3.8-livetranslate-flash-realtime';
export const BAILIAN_NOTES_MODEL = 'qwen3.8-flash';

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  billableTokens: number;
}

function realtimeTotals(raw: unknown): TokenTotals | null {
  const usage = object(raw);
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;

  const input = object(usage?.input_tokens_details);
  const fixedPrompt = Math.min(inputTokens, count(input?.text_tokens) ?? 0);
  return {
    inputTokens,
    outputTokens,
    billableTokens: inputTokens - fixedPrompt + outputTokens,
  };
}

/** One tracker per upstream WebSocket. The service's `response.done` usage is a session snapshot.
 * https://help.aliyun.com/zh/model-studio/live-translator-server-events
 */
export function trackRealtimeUsage(
  activity: Exclude<UsageActivity, 'notes'>,
  provider: string,
  model: string,
  record: (usage: UsageDelta) => void = recordUsage,
): (raw: unknown) => void {
  let previous: TokenTotals = { inputTokens: 0, outputTokens: 0, billableTokens: 0 };
  return (raw) => {
    const next = realtimeTotals(raw);
    if (!next || next.inputTokens < previous.inputTokens || next.outputTokens < previous.outputTokens) return;
    const inputTokens = next.inputTokens - previous.inputTokens;
    const outputTokens = next.outputTokens - previous.outputTokens;
    if (!inputTokens && !outputTokens) return;
    record({
      activity, provider, model, inputTokens, outputTokens,
      billableTokens: Math.max(0, next.billableTokens - previous.billableTokens),
    });
    previous = next;
  };
}

export function recordNotesUsage(provider: string, model: string, raw: unknown, historyId?: string): void {
  const usage = object(raw);
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  if (inputTokens === null || outputTokens === null || (!inputTokens && !outputTokens)) return;
  const delta = { inputTokens, outputTokens, billableTokens: inputTokens + outputTokens };
  recordUsage({ activity: 'notes', provider, model, ...delta });
  if (historyId) recordHistoryNotes(historyId, delta);
}
