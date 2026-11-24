// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { BAILIAN_BEIJING, billingMonth, recordUsage, remainingQuota, useUsageStore } from './ledger';
import { LIVE_TRANSLATE_MODEL, recordNotesUsage, trackRealtimeUsage } from './providerUsage';
import { beginSessionTokens, bindSessionTokens, finishSessionTokens, linkSessionTokens, removeHistoryTokens, unlinkSessionTokens, useSessionTokenStore } from './sessionTokens';

afterEach(() => {
  useUsageStore.setState({ rows: [], quotas: {} });
  useSessionTokenStore.setState({ meeting: null, 'face-to-face': null, history: [], notesByRecord: {} });
  localStorage.removeItem('aed.tokenUsage.v2');
  localStorage.removeItem('aed.sessionTokens.v1');
});

const snapshot = (audio: number, output: number) => ({
  input_tokens: 20 + audio, output_tokens: output, input_tokens_details: { text_tokens: 20, audio_tokens: audio },
});

it('sums both connections and reconnects, ignores duplicate snapshots, and resets only on the next session', () => {
  const id = beginSessionTokens('meeting', 10, true);
  const meter = bindSessionTokens('meeting')!;
  const track = () => trackRealtimeUsage('meeting', BAILIAN_BEIJING, LIVE_TRANSLATE_MODEL, meter);
  expect(useSessionTokenStore.getState().meeting).toMatchObject({ totalTokens: 0, reported: false });
  const speaker = track();
  const participant = track();
  speaker(snapshot(10, 2));
  speaker(snapshot(10, 2));
  speaker(snapshot(25, 3));
  speaker(snapshot(10, 2));
  participant(snapshot(5, 1));
  track()(snapshot(3, 2));
  const total = { inputTokens: 93, outputTokens: 6, totalTokens: 99, billableTokens: 39 };
  expect(useSessionTokenStore.getState().meeting).toMatchObject(total);
  linkSessionTokens('meeting', id, 'session-meeting-history-test');
  finishSessionTokens('meeting', id, 20);
  expect(useSessionTokenStore.getState().history).toEqual([
    { id, activity: 'meeting', startedAt: 10, endedAt: 20, historyId: 'session-meeting-history-test', ...total, reported: true },
  ]);
  expect(useSessionTokenStore.getState().meeting).toMatchObject(total);
  const next = beginSessionTokens('meeting', 30, true);
  const nextMeter = bindSessionTokens('meeting')!;
  speaker(snapshot(40, 5));
  expect(useSessionTokenStore.getState().meeting?.totalTokens).toBe(0);
  nextMeter({ inputTokens: 7, outputTokens: 8, billableTokens: 15 });
  finishSessionTokens('meeting', next, 40);
  expect(useSessionTokenStore.getState().history.map((row) => row.totalTokens)).toEqual([15, 99]);
});

it('keeps real face-to-face sessions separate, excludes replays, and removes usage with purged history', () => {
  const record = 'session-purge-history-test';
  const face = beginSessionTokens('face-to-face', 1, true);
  bindSessionTokens('face-to-face')?.({ inputTokens: 10, outputTokens: 11, billableTokens: 21 });
  finishSessionTokens('face-to-face', face, 2);
  const replay = beginSessionTokens('face-to-face', 3, false);
  bindSessionTokens('face-to-face')?.({ inputTokens: 20, outputTokens: 21, billableTokens: 41 });
  finishSessionTokens('face-to-face', replay, 4);
  const meeting = beginSessionTokens('meeting', 5, true);
  linkSessionTokens('meeting', meeting, record);
  bindSessionTokens('meeting')?.({ inputTokens: 20, outputTokens: 22, billableTokens: 42 });
  finishSessionTokens('meeting', meeting, 6);
  recordNotesUsage('compatible', 'notes-test', { prompt_tokens: 9, completion_tokens: 13 }, record);
  expect(useSessionTokenStore.getState().notesByRecord[record].totalTokens).toBe(22);
  removeHistoryTokens([record]);
  recordNotesUsage('compatible', 'notes-test', { prompt_tokens: 1, completion_tokens: 2 }, record);
  expect(useSessionTokenStore.getState().notesByRecord[record]).toBeUndefined();
  expect(useSessionTokenStore.getState().history.map((row) => row.id)).toEqual([face]);
  expect(JSON.parse(localStorage.getItem('aed.sessionTokens.v1')!).history).toHaveLength(1);
});

it('retains metered use as a standalone session if History discards an empty transcript', () => {
  const id = beginSessionTokens('meeting', 1, true);
  bindSessionTokens('meeting')?.({ inputTokens: 3, outputTokens: 4, billableTokens: 7 });
  linkSessionTokens('meeting', id, 'discarded-empty-transcript');
  finishSessionTokens('meeting', id, 2);
  unlinkSessionTokens('discarded-empty-transcript');
  expect(useSessionTokenStore.getState().history[0]).toMatchObject({ id, totalTokens: 7 });
  expect(useSessionTokenStore.getState().history[0].historyId).toBeUndefined();
});

it('calculates quota from only the specified model’s Bailian usage across a month boundary', () => {
  const priorMonth = Date.parse('2026-11-30T15:59:59Z');
  const nextMonth = Date.parse('2026-11-30T16:00:00Z');
  const usage = { provider: BAILIAN_BEIJING, activity: 'meeting' as const, model: LIVE_TRANSLATE_MODEL, inputTokens: 80, outputTokens: 20, billableTokens: 90 };
  expect(billingMonth(priorMonth)).toBe('2026-11');
  expect(billingMonth(nextMonth)).toBe('2026-12');
  recordUsage(usage, priorMonth);
  expect(useUsageStore.getState().setQuota(LIVE_TRANSLATE_MODEL, 200)).toBe(true);
  recordUsage(usage, nextMonth);
  recordUsage({ ...usage, provider: 'qwencloud' }, nextMonth);
  recordUsage({ ...usage, model: 'qwen3.8-flash' }, nextMonth);
  const { rows, quotas } = useUsageStore.getState();
  expect(remainingQuota(rows, LIVE_TRANSLATE_MODEL, quotas[LIVE_TRANSLATE_MODEL])).toBe(110);
});
