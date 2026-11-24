/**
 * A small, opt-in Qwen 3.8 voice comparison runner. It deliberately records
 * timing and event counts only: never text, PCM, credentials, or voice IDs.
 * The socket and session update use the same header seam and wire as the app.
 */
import { SAMPLE_RATE } from '../../lib/contract/adapter';
import { realClock } from '../../lib/contract/clock';
import type { OpenHeaderSocket } from '../../lib/contract/headerSocket';
import { platformHeaderSocket } from '../../lib/contract/headerSocket';
import { appendFrame, base64ToPcm, COMMIT, decodeServerEvent, qwenHeaders, sessionUpdate, socketUrl, type ServerEvent } from './wire';
import { bailianWorkspaceSocketUrl, type EndpointId } from './endpoints';
import { QWEN_MODEL } from './settings';

const RATE = SAMPLE_RATE;
const FRAME_SAMPLES = RATE / 50; // 20 ms at the provider's input rate.
const SESSION_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 15_000;

export type QwenVoiceBenchmarkMode = 'preset_tina' | 'clone_always' | 'fixed_never';
export type QwenVoiceBenchmarkResult = 'completed' | 'incomplete' | 'failed' | 'aborted';

export interface QwenVoiceBenchmarkTrial {
  round: number;
  clip: number;
  mode: QwenVoiceBenchmarkMode;
  result: QwenVoiceBenchmarkResult;
  failure: 'socket' | 'session_timeout' | 'server_error' | 'protocol_error' | 'response_timeout' | 'connection_closed' | 'empty_audio' | 'response_failed' | 'aborted' | null;
  requestToReadyMs: number | null;
  audioToFirstPcmMs: number | null;
  utteranceEndToFirstPcmMs: number | null;
  utteranceEndToResponseDoneMs: number | null;
  responseStatus: string | null;
  responseDoneEvents: number;
  audioDeltaEvents: number;
  outputPcmSamples: number;
  outputPcmDurationMs: number;
  inputPcmSamples: number;
};

export interface QwenVoiceBenchmarkReport {
  sampleRate: typeof RATE;
  requestedRounds: number;
  completedTrials: number;
  incompleteTrials: number;
  failedTrials: number;
  aborted: boolean;
  trials: QwenVoiceBenchmarkTrial[];
}

export interface QwenVoiceBenchmarkClip {
  /** The clip label is intentionally not copied into the result. */
  pcm: Float32Array | Int16Array;
  sampleRate?: number;
}

export interface QwenVoiceBenchmarkArgs {
  endpoint: EndpointId;
  apiKey: string;
  /** The selected, owned fixed profile from the renderer. Never returned or logged. */
  fixedVoice: string;
  clips: readonly QwenVoiceBenchmarkClip[];
  /** Defaults to one round so callers can keep each app IPC request bounded. */
  rounds?: number;
  /** Initial profile rotation; 0/1/2 can be used for successive CLI requests. */
  startRound?: number;
  targetLanguage?: string;
  /** For the configured dedicated Bailian host, if this call is pointed at it. */
  workspaceId?: string;
  openHeaderSocket?: OpenHeaderSocket;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface TrialState {
  notify: (() => void) | null;
  sessionCreated: boolean;
  sessionUpdated: boolean;
  responseDoneAt: number | null;
  responseStatus: string | null;
  responseDoneEvents: number;
  audioDeltaEvents: number;
  outputPcmSamples: number;
  firstPcmAt: number | null;
  failure: QwenVoiceBenchmarkTrial['failure'];
}

const MODES: readonly QwenVoiceBenchmarkMode[] = ['preset_tina', 'clone_always', 'fixed_never'];

function abortError(): Error {
  const e = new Error('Benchmark aborted.');
  e.name = 'AbortError';
  return e;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toProviderPcm(input: Float32Array | Int16Array, sourceRate: number): Int16Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new RangeError('Clip sample rate must be positive.');
  const sourceLength = input.length;
  if (!sourceLength) throw new RangeError('Benchmark clips must contain audio.');
  const targetLength = Math.max(1, Math.round(sourceLength * RATE / sourceRate));
  const out = new Int16Array(targetLength);
  for (let i = 0; i < targetLength; i += 1) {
    const position = i * sourceRate / RATE;
    const left = Math.min(sourceLength - 1, Math.floor(position));
    const right = Math.min(sourceLength - 1, left + 1);
    const fraction = position - left;
    const a = input[left];
    const b = input[right];
    const sample = input instanceof Int16Array ? a + (b - a) * fraction : (a + (b - a) * fraction) * 32768;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }
  return out;
}

function responseStatus(value: unknown): string | null {
  // Status is useful evidence, but do not copy arbitrary server text to output.
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : null;
}

function updateFor(mode: QwenVoiceBenchmarkMode, fixedVoice: string, target: string) {
  const voice = mode === 'preset_tina'
    ? { kind: 'preset' as const, name: 'Tina' }
    : mode === 'clone_always'
      ? { kind: 'clone' as const, frequency: 'always' as const }
      : { kind: 'fixed' as const, id: fixedVoice, ownerHash: '' };
  return sessionUpdate({
    target,
    speech: true,
    voice,
    manual: true,
    phrases: {},
    silenceMs: null,
  }, { video: false });
}

function trialRecord(round: number, clip: number, mode: QwenVoiceBenchmarkMode): QwenVoiceBenchmarkTrial {
  return {
    round, clip, mode, result: 'failed', failure: null,
    requestToReadyMs: null, audioToFirstPcmMs: null, utteranceEndToFirstPcmMs: null,
    utteranceEndToResponseDoneMs: null, responseStatus: null, responseDoneEvents: 0,
    audioDeltaEvents: 0, outputPcmSamples: 0, outputPcmDurationMs: 0, inputPcmSamples: 0,
  };
}

async function runTrial(args: QwenVoiceBenchmarkArgs, round: number, clipIndex: number, mode: QwenVoiceBenchmarkMode, now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<void>): Promise<QwenVoiceBenchmarkTrial> {
  const result = trialRecord(round, clipIndex + 1, mode);
  const startedAt = now();
  const pcm = toProviderPcm(args.clips[clipIndex].pcm, args.clips[clipIndex].sampleRate ?? RATE);
  result.inputPcmSamples = pcm.length;
  const target = args.targetLanguage ?? 'en';
  const url = args.workspaceId
    ? bailianWorkspaceSocketUrl(args.workspaceId, QWEN_MODEL)
    : socketUrl(args.endpoint, QWEN_MODEL);
  const headers = qwenHeaders({ apiKey: args.apiKey }, Boolean(args.workspaceId));
  const open = args.openHeaderSocket ?? platformHeaderSocket;
  let socket: WebSocket | null = null;
  const state: TrialState = {
    notify: null, sessionCreated: false, sessionUpdated: false,
    responseDoneAt: null, responseStatus: null, responseDoneEvents: 0,
    audioDeltaEvents: 0, outputPcmSamples: 0, firstPcmAt: null, failure: null,
  };
  const wake = () => { state.notify?.(); state.notify = null; };
  const waitUntil = async (check: () => boolean, timeoutMs: number, timeoutFailure: 'session_timeout' | 'response_timeout') => {
    const deadline = now() + timeoutMs;
    while (!check()) {
      if (args.signal?.aborted) throw abortError();
      if (state.failure) throw new Error(state.failure);
      const remaining = deadline - now();
      if (remaining <= 0) { result.failure = timeoutFailure; throw new Error(timeoutFailure); }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(timeoutFailure)); }, remaining);
        const onAbort = () => { cleanup(); reject(abortError()); };
        const cleanup = () => { clearTimeout(timer); args.signal?.removeEventListener('abort', onAbort); state.notify = null; };
        state.notify = () => { cleanup(); resolve(); };
        args.signal?.addEventListener('abort', onAbort, { once: true });
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === timeoutFailure) result.failure = timeoutFailure;
        throw error;
      });
    }
  };
  try {
    if (args.signal?.aborted) throw abortError();
    socket = await open(url, headers, { signal: args.signal ?? new AbortController().signal, clock: realClock });
    socket.addEventListener('message', (message: MessageEvent) => {
      try {
        const event: ServerEvent = decodeServerEvent(message.data);
        if (event.type === 'session.created') state.sessionCreated = true;
        else if (event.type === 'session.updated') state.sessionUpdated = true;
        else if (event.type === 'response.audio.delta') {
          state.audioDeltaEvents += 1;
          if (typeof event.delta === 'string') {
            const output = base64ToPcm(event.delta);
            state.outputPcmSamples += output.length;
            if (output.length && state.firstPcmAt === null) state.firstPcmAt = now();
          } else state.failure = 'protocol_error';
        } else if (event.type === 'response.done') {
          const response = typeof event.response === 'object' && event.response !== null ? event.response as { status?: unknown } : {};
          state.responseDoneEvents += 1;
          state.responseStatus = responseStatus(response.status);
          state.responseDoneAt = now();
        } else if (event.type === 'error') state.failure = 'server_error';
        wake();
      } catch {
        state.failure = 'protocol_error';
        wake();
      }
    });
    socket.addEventListener('close', () => { if (state.responseDoneAt === null) { state.failure = 'connection_closed'; wake(); } });
    socket.addEventListener('error', () => { if (state.responseDoneAt === null) { state.failure = 'socket'; wake(); } });
    await waitUntil(() => state.sessionCreated, SESSION_TIMEOUT_MS, 'session_timeout');
    socket.send(JSON.stringify({ type: 'session.update', session: updateFor(mode, args.fixedVoice, target).session }));
    await waitUntil(() => state.sessionUpdated, SESSION_TIMEOUT_MS, 'session_timeout');
    result.requestToReadyMs = now() - startedAt;
    const audioStartedAt = now();
    for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
      if (args.signal?.aborted) throw abortError();
      const frameEnd = Math.min(pcm.length, offset + FRAME_SAMPLES);
      socket.send(appendFrame(pcm.subarray(offset, frameEnd)));
      // Anchor pacing to the clip so delayed Windows timer callbacks do not
      // accumulate and change the playback speed between voice modes.
      const remaining = audioStartedAt + frameEnd / RATE * 1000 - now();
      if (remaining > 0) await sleep(remaining, args.signal);
    }
    const utteranceEndedAt = now();
    socket.send(JSON.stringify(COMMIT));
    try {
      await waitUntil(() => state.responseDoneAt !== null, RESPONSE_TIMEOUT_MS, 'response_timeout');
    } catch (error) {
      if (args.signal?.aborted) throw error;
      if (!result.failure) result.failure = state.failure ?? 'response_timeout';
    }
    result.responseStatus = state.responseStatus;
    result.responseDoneEvents = state.responseDoneEvents;
    result.audioDeltaEvents = state.audioDeltaEvents;
    result.outputPcmSamples = state.outputPcmSamples;
    result.outputPcmDurationMs = state.outputPcmSamples / RATE * 1000;
    if (state.firstPcmAt !== null) {
      result.audioToFirstPcmMs = state.firstPcmAt - audioStartedAt;
      result.utteranceEndToFirstPcmMs = state.firstPcmAt - utteranceEndedAt;
    }
    if (state.responseDoneAt !== null) result.utteranceEndToResponseDoneMs = state.responseDoneAt - utteranceEndedAt;
    if (state.responseDoneAt !== null && state.responseStatus === 'completed' && state.outputPcmSamples > 0 && !state.failure) {
      result.result = 'completed';
      result.failure = null;
    } else if (state.responseDoneAt !== null) {
      result.result = 'incomplete';
      result.failure = state.failure ?? (state.outputPcmSamples === 0 ? 'empty_audio' : 'response_failed');
    } else {
      result.result = 'incomplete';
      result.failure ??= 'response_timeout';
    }
  } catch (error) {
    if (args.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      result.result = 'aborted';
      result.failure = 'aborted';
    } else {
      result.result = 'failed';
      result.failure ??= state.failure ?? (result.failure === 'session_timeout' ? 'session_timeout' : 'socket');
    }
    result.responseStatus = state.responseStatus;
    result.responseDoneEvents = state.responseDoneEvents;
    result.audioDeltaEvents = state.audioDeltaEvents;
    result.outputPcmSamples = state.outputPcmSamples;
    result.outputPcmDurationMs = state.outputPcmSamples / RATE * 1000;
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'benchmark complete');
  }
  return result;
}

/** Run matched clips in three interleaved voice modes through Qwen's real wire. */
export async function runQwenVoiceBenchmark(args: QwenVoiceBenchmarkArgs): Promise<QwenVoiceBenchmarkReport> {
  if (!args.apiKey.trim()) throw new Error('A configured Qwen API key is required.');
  if (!args.fixedVoice.trim()) throw new Error('A fixed voice profile is required.');
  if (!args.clips.length) throw new Error('At least one benchmark clip is required.');
  const rounds = Math.max(1, Math.min(4, Math.floor(args.rounds ?? 1)));
  const now = args.now ?? (() => performance.now());
  const sleep = args.sleep ?? defaultSleep;
  const trials: QwenVoiceBenchmarkTrial[] = [];
  const start = ((Math.floor(args.startRound ?? 0) % MODES.length) + MODES.length) % MODES.length;
  let aborted = false;
  for (let round = 0; round < rounds; round += 1) {
    const rotation = (start + round) % MODES.length;
    for (let clip = 0; clip < args.clips.length; clip += 1) {
      for (let offset = 0; offset < MODES.length; offset += 1) {
        const mode = MODES[(rotation + offset) % MODES.length];
        const result = await runTrial(args, round + 1, clip, mode, now, sleep);
        trials.push(result);
        if (result.result === 'aborted') { aborted = true; break; }
      }
      if (aborted) break;
    }
    if (aborted) break;
  }
  return {
    sampleRate: RATE,
    requestedRounds: rounds,
    completedTrials: trials.filter((trial) => trial.result === 'completed').length,
    incompleteTrials: trials.filter((trial) => trial.result === 'incomplete').length,
    failedTrials: trials.filter((trial) => trial.result === 'failed' || trial.result === 'aborted').length,
    aborted,
    trials,
  };
}
