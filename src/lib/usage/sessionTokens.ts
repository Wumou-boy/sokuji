import { create } from 'zustand';

type SessionActivity = 'meeting' | 'face-to-face';

export interface SessionTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  billableTokens: number;
  reported: boolean;
}

export interface SessionTokenRecord extends SessionTokens {
  id: string;
  activity: SessionActivity;
  startedAt: number;
  endedAt: number;
  historyId?: string;
}

type Delta = Pick<SessionTokens, 'inputTokens' | 'outputTokens' | 'billableTokens'>;
type Stored = { history: readonly SessionTokenRecord[]; notesByRecord: Readonly<Record<string, SessionTokens>> };
type SessionTokenState = Stored & Record<SessionActivity, SessionTokens | null>;

const STORAGE_KEY = 'aed.sessionTokens.v1';
const EMPTY: SessionTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, billableTokens: 0, reported: false };
const active: Partial<Record<SessionActivity, {
  id: string; startedAt: number; keep: boolean; historyId?: string;
}>> = {};
const removedRecords = new Set<string>();

function readHistory(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<Stored>;
      if (Array.isArray(value.history) && value.notesByRecord && typeof value.notesByRecord === 'object') {
        return { history: value.history, notesByRecord: value.notesByRecord };
      }
    }
  } catch { /* A missing or corrupt local count does not prevent translation. */ }
  return { history: [], notesByRecord: {} };
}

export const useSessionTokenStore = create<SessionTokenState>(() => ({
  meeting: null, 'face-to-face': null, ...readHistory(),
}));

function save(history: Stored['history'], notesByRecord: Stored['notesByRecord']): void {
  useSessionTokenStore.setState({ history, notesByRecord });
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ history, notesByRecord })); }
  catch { /* Counts stay visible while the application is open. */ }
}

function add(tokens: SessionTokens, delta: Delta): SessionTokens {
  const inputTokens = tokens.inputTokens + delta.inputTokens;
  const outputTokens = tokens.outputTokens + delta.outputTokens;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, billableTokens: tokens.billableTokens + delta.billableTokens, reported: true };
}

export function beginSessionTokens(activity: SessionActivity, startedAt: number, keep: boolean): string {
  const id = globalThis.crypto.randomUUID();
  active[activity] = { id, startedAt, keep };
  useSessionTokenStore.setState({ [activity]: null });
  return id;
}

/** Bind once when the adapter starts. Its reconnects and late events keep this session identity. */
export function bindSessionTokens(activity: SessionActivity): ((delta: Delta) => void) | undefined {
  const session = active[activity];
  if (!session) return;
  if (useSessionTokenStore.getState()[activity] === null) useSessionTokenStore.setState({ [activity]: EMPTY });
  return (delta) => {
    if (active[activity] !== session) return;
    useSessionTokenStore.setState((state) => ({ [activity]: add(state[activity] ?? EMPTY, delta) }));
  };
}

export function linkSessionTokens(activity: SessionActivity, id: string, historyId: string): void {
  const session = active[activity];
  if (session?.id === id) session.historyId = historyId;
}

export function finishSessionTokens(activity: SessionActivity, id: string, endedAt: number): void {
  const session = active[activity];
  if (!session || session.id !== id) return;
  delete active[activity];
  const state = useSessionTokenStore.getState();
  const tokens = state[activity];
  if (!session.keep || !tokens?.reported) return;
  save([{
    id, activity, startedAt: session.startedAt, endedAt, ...tokens,
    ...(session.historyId ? { historyId: session.historyId } : {}),
  }, ...state.history], state.notesByRecord);
}

/** When History discards an empty transcript, keep only the anonymous session count. */
export function unlinkSessionTokens(historyId: string): void {
  removedRecords.add(historyId);
  const { history, notesByRecord } = useSessionTokenStore.getState();
  if (!history.some((record) => record.historyId === historyId) && !Object.prototype.hasOwnProperty.call(notesByRecord, historyId)) return;
  const notes = { ...notesByRecord };
  delete notes[historyId];
  save(history.map((record) => record.historyId === historyId ? { ...record, historyId: undefined } : record), notes);
}

export function recordHistoryNotes(historyId: string, delta: Delta): void {
  if (removedRecords.has(historyId)) return;
  const { history, notesByRecord } = useSessionTokenStore.getState();
  save(history, { ...notesByRecord, [historyId]: add(notesByRecord[historyId] ?? EMPTY, delta) });
}

export function removeHistoryTokens(ids: readonly string[]): void {
  const { history, notesByRecord } = useSessionTokenStore.getState();
  const deleted = new Set(ids);
  ids.forEach((id) => removedRecords.add(id));
  const kept = history.filter((record) => !deleted.has(record.historyId ?? record.id));
  const notes = Object.fromEntries(Object.entries(notesByRecord).filter(([id]) => !deleted.has(id)));
  if (kept.length !== history.length || Object.keys(notes).length !== Object.keys(notesByRecord).length) save(kept, notes);
}
