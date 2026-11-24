import { create } from 'zustand';

export type UsageActivity = 'meeting' | 'face-to-face' | 'notes';

export interface UsageDelta {
  activity: UsageActivity;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  billableTokens: number;
}

export interface UsageRow extends UsageDelta {
  month: string;
}

export interface QuotaSnapshot {
  remainingTokens: number;
  capturedAt: number;
  baselineTokens: number;
}

interface UsageData {
  rows: UsageRow[];
  quotas: Record<string, QuotaSnapshot>;
}

interface UsageStore extends UsageData {
  setQuota(model: string, remainingTokens: number): boolean;
}

const KEY = 'aed.tokenUsage.v2';
export const BAILIAN_BEIJING = 'bailian-beijing';
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function billingMonth(now = Date.now()): string {
  return new Date(now + CHINA_OFFSET_MS).toISOString().slice(0, 7);
}

const isTokenCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

function load(): UsageData {
  try {
    const raw = globalThis.localStorage?.getItem(KEY) ?? globalThis.localStorage?.getItem('aed.usage.v1');
    if (raw !== null && raw !== undefined) {
      const { rows, quotas } = JSON.parse(raw) as UsageData;
      if (Array.isArray(rows) && quotas) return {
        rows: rows.map(({ month, activity, provider, model, inputTokens, outputTokens, billableTokens }) =>
          ({ month, activity, provider, model, inputTokens, outputTokens, billableTokens })),
        quotas,
      };
    }
  } catch { /* An unavailable or corrupt ledger starts empty. */ }
  return { rows: [], quotas: {} };
}

function persist({ rows, quotas }: UsageData): boolean {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(KEY, JSON.stringify({ rows, quotas }));
    return true;
  } catch {
    return false;
  }
}

function bailianTokens(rows: readonly UsageRow[], model: string): number {
  return rows.reduce((sum, row) => row.provider === BAILIAN_BEIJING && row.model === model ? sum + row.billableTokens : sum, 0);
}

export function remainingQuota(rows: readonly UsageRow[], model: string, snapshot: QuotaSnapshot): number {
  const consumedHere = Math.max(0, bailianTokens(rows, model) - snapshot.baselineTokens);
  return Math.max(0, snapshot.remainingTokens - consumedHere);
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  ...load(),
  setQuota(model, remainingTokens) {
    if (!model || !isTokenCount(remainingTokens)) return false;
    const current = get();
    const snapshot = { remainingTokens, capturedAt: Date.now(), baselineTokens: bailianTokens(current.rows, model) };
    const next = { ...current, quotas: { ...current.quotas, [model]: snapshot } };
    if (!persist(next)) return false;
    set({ quotas: next.quotas });
    return true;
  },
}));

/** Only aggregate metadata is stored. A storage failure must not interrupt a meeting or notes. */
export function recordUsage(usage: UsageDelta, now = Date.now()): void {
  if (!usage.model || ![usage.inputTokens, usage.outputTokens, usage.billableTokens].every(isTokenCount)) return;
  const month = billingMonth(now);
  useUsageStore.setState((state) => {
    const match = state.rows.findIndex((row) => row.month === month && row.activity === usage.activity &&
      row.provider === usage.provider && row.model === usage.model);
    const rows = [...state.rows];
    if (match < 0) {
      rows.push({ ...usage, month });
    } else {
      const row = rows[match];
      rows[match] = {
        ...row,
        inputTokens: row.inputTokens + usage.inputTokens,
        outputTokens: row.outputTokens + usage.outputTokens,
        billableTokens: row.billableTokens + usage.billableTokens,
      };
    }
    persist({ ...state, rows });
    return { rows };
  });
}
