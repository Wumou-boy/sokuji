import { SAMPLE_RATE, type AdapterEvents, type AdapterSession } from '../../lib/contract/adapter';

/** Keep one replay below Qwen's documented/probed 30-second audio turn ceiling. */
export const QWEN_FACE_REPLAY_MAX_SAMPLES = SAMPLE_RATE * 30;
const REPLAY_FRAME_SAMPLES = SAMPLE_RATE / 10;
/** The adapter reports its own 10 s manual-turn timeout first; this is a final bounded fallback. */
export const QWEN_FACE_REPLAY_RESPONSE_TIMEOUT_MS = 12_000;

export interface QwenFaceReplayOptions {
  /** Starts the app-configured, text-only Qwen adapter. This is called lazily on the first replay. */
  start: (events: AdapterEvents, signal: AbortSignal) => Promise<AdapterSession>;
  /** Owns the lifetime of this auxiliary connection. */
  signal: AbortSignal;
  /** Injectable for deterministic tests; production leaves the bounded default. */
  responseTimeoutMs?: number;
}

export interface QwenFaceReplay {
  /** Replay one finalized PCM16/24 kHz mono segment and return its single completed translation. */
  translate(pcm: Int16Array, signal?: AbortSignal): Promise<string>;
  /** Send PCM as it arrives and publish changed translation snapshots until the turn completes. */
  translateStream(source: AsyncIterable<Int16Array>, signal: AbortSignal, onText: (text: string) => void): Promise<string>;
  stop(): Promise<void>;
}

interface TranslationSegment {
  closed: boolean;
  origin?: string;
  text: string;
}

interface ActiveTurn {
  generation: number;
  segments: Map<number, TranslationSegment>;
  frameSegments: Map<string, TranslationSegment>;
  onText?: (text: string) => void;
  emittedText: Map<number, string>;
  lastPublishedText?: string;
  finish: (error?: unknown) => void;
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Qwen face replay was cancelled.');
}

function errorFromEvent(event: unknown): Error {
  if (typeof event === 'object' && event !== null && 'message' in event && typeof event.message === 'string') {
    return new Error(event.message);
  }
  return new Error('Qwen face replay session ended.');
}

/**
 * A deliberately small, app-configured manual-turn transport for face-to-face audio.
 * It opens no realtime session until requested, reuses that session, and never joins separate
 * translation refs: one replay must produce exactly one closed translation segment.
 */
export function createQwenFaceReplay(options: QwenFaceReplayOptions): QwenFaceReplay {
  const lifetime = new AbortController();
  let stopped = false;
  let session: AdapterSession | null = null;
  let sessionGeneration: number | null = null;
  let opening: Promise<AdapterSession> | null = null;
  let openingGeneration: number | null = null;
  let generation = 0;
  let active: ActiveTurn | null = null;
  let tail: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | null = null;

  const failActive = (error: unknown, expectedGeneration?: number) => {
    if (!active || (expectedGeneration !== undefined && active.generation !== expectedGeneration)) return;
    const turn = active;
    active = null;
    turn.finish(error);
  };

  const retireSession = (id: number, error: Error) => {
    if (generation !== id) return;
    generation += 1;
    const old = sessionGeneration === id ? session : null;
    if (sessionGeneration === id) {
      session = null;
      sessionGeneration = null;
    }
    if (openingGeneration === id) {
      opening = null;
      openingGeneration = null;
    }
    failActive(error, id);
    // AdapterSession.stop() closes synchronously before its first await.
    if (old) void old.stop().catch(() => {});
  };

  const eventsFor = (id: number): AdapterEvents => ({
    segmentOpened(event) {
      const turn = active;
      if (generation !== id || event.side !== 'translation' || !turn || turn.generation !== id) return;
      turn.segments.set(event.ref, { closed: false, origin: event.origin, text: '' });
    },
    segmentText(event) {
      const turn = active;
      if (generation !== id || !turn || turn.generation !== id) return;
      const segment = turn.segments.get(event.ref);
      if (segment && !segment.closed) {
        segment.text = event.text;
        if (event.text.trim() && turn.emittedText.get(event.ref) !== event.text) {
          turn.emittedText.set(event.ref, event.text);
          if (turn.lastPublishedText !== event.text) {
            turn.lastPublishedText = event.text;
            turn.onText?.(event.text);
          }
        }
      }
    },
    segmentClosed(event) {
      const turn = active;
      if (generation !== id || !turn || turn.generation !== id) return;
      const segment = turn.segments.get(event.ref);
      if (segment) segment.closed = true;
    },
    audio() {},
    speechRanges() {},
    closed(event) {
      retireSession(id, errorFromEvent(event));
    },
    reconnecting() {},
    reconnected() {},
    failed(event) {
      retireSession(id, errorFromEvent(event));
    },
    degraded() {},
    loading() {},
    busy() {},
    frame(event) {
      const turn = active;
      if (generation !== id || !turn || turn.generation !== id) return;
      if (event.type === 'response.text.delta' || event.type === 'response.text.done') {
        const payload = typeof event.payload === 'object' && event.payload !== null
          ? event.payload as { itemId?: unknown; delta?: unknown; text?: unknown }
          : {};
        const itemId = typeof payload.itemId === 'string' ? payload.itemId : undefined;
        // These raw frames are Qwen model output, so their item is a translation. Ignore the
        // frame path when the structured segment callback already identifies that item.
        if (itemId && ![...turn.segments.values()].some((segment) => segment.origin === itemId)) {
          let segment = turn.frameSegments.get(itemId);
          if (!segment) {
            segment = { closed: false, text: '' };
            turn.frameSegments.set(itemId, segment);
          }
          if (!segment.closed) {
            const text = event.type === 'response.text.delta' && typeof payload.delta === 'string'
              ? segment.text + payload.delta
              : event.type === 'response.text.done' && typeof payload.text === 'string'
                ? payload.text
                : segment.text;
            segment.text = text;
            if (event.type === 'response.text.done') segment.closed = true;
            if (text.trim() && turn.lastPublishedText !== text) {
              turn.lastPublishedText = text;
              turn.onText?.(text);
            }
          }
        }
        return;
      }
      if (event.type === 'session.turn_timeout') {
        retireSession(id, new Error('Qwen face replay response timed out; the next replay will open a fresh session.'));
        return;
      }
      if (event.type !== 'response.done') return;
      const payload = event.payload;
      const status = typeof payload === 'object' && payload !== null && 'status' in payload
        ? (payload as { status?: unknown }).status
        : undefined;
      if (status !== 'completed') {
        failActive(new Error(`Qwen replay response did not complete${typeof status === 'string' ? ` (${status})` : ''}.`), id);
        return;
      }
      active = null;
      turn.finish();
    },
  });

  const ensureSession = async (): Promise<AdapterSession> => {
    if (stopped || options.signal.aborted || lifetime.signal.aborted) throw abortError(options.signal.aborted ? options.signal : lifetime.signal);
    if (session) return session;
    if (!opening) {
      const id = ++generation;
      let attempt!: Promise<AdapterSession>;
      attempt = options.start(eventsFor(id), lifetime.signal).then(async (opened) => {
        if (stopped || lifetime.signal.aborted || generation !== id) {
          await opened.stop();
          throw abortError(lifetime.signal);
        }
        session = opened;
        sessionGeneration = id;
        return opened;
      }).catch((error: unknown) => {
        if (generation === id) generation += 1;
        if (openingGeneration === id && opening === attempt) {
          opening = null;
          openingGeneration = null;
        }
        throw error;
      });
      openingGeneration = id;
      opening = attempt;
    }
    const pending = opening;
    if (!pending) throw new Error('Qwen face replay session could not be started.');
    return pending;
  };

  const runTurn = async (
    pcm: Int16Array | undefined,
    source: AsyncIterable<Int16Array> | undefined,
    requestSignal: AbortSignal | undefined,
    onText?: (text: string) => void,
  ): Promise<string> => {
    if (requestSignal?.aborted) throw abortError(requestSignal);
    if (options.signal.aborted || lifetime.signal.aborted || stopped) throw abortError(options.signal.aborted ? options.signal : lifetime.signal);
    if (pcm && pcm.length === 0) throw new Error('Qwen face replay needs a non-empty finalized audio segment.');
    if (pcm && pcm.length >= QWEN_FACE_REPLAY_MAX_SAMPLES) throw new Error('Qwen face replay audio must be shorter than 30 seconds.');

    const live = await ensureSession();
    if (requestSignal?.aborted) throw abortError(requestSignal);
    if (stopped || lifetime.signal.aborted) throw abortError(lifetime.signal);

    let settle!: (error?: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      settle = (error) => error === undefined ? resolve() : reject(error);
    });
    const id = sessionGeneration;
    if (id === null) throw new Error('Qwen face replay session was not ready.');
    const turn = {
      generation: id,
      segments: new Map<number, TranslationSegment>(),
      frameSegments: new Map<string, TranslationSegment>(),
      onText,
      emittedText: new Map<number, string>(),
      finish: settle,
      done,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    } satisfies ActiveTurn;
    turn.finish = (error?: unknown) => {
      clearTimeout(turn.timer);
      settle(error);
    };
    active = turn;
    const timeoutMs = options.responseTimeoutMs ?? QWEN_FACE_REPLAY_RESPONSE_TIMEOUT_MS;
    let responseEndedEarly = false;

    try {
      live.beginTurn();
      let totalSamples = 0;
      const appendChunk = (chunk: Int16Array) => {
        if (requestSignal?.aborted) throw abortError(requestSignal);
        totalSamples += chunk.length;
        if (totalSamples >= QWEN_FACE_REPLAY_MAX_SAMPLES) throw new Error('Qwen face replay audio must be shorter than 30 seconds.');
        for (let offset = 0; offset < chunk.length; offset += REPLAY_FRAME_SAMPLES) {
          live.appendAudio(chunk.subarray(offset, Math.min(offset + REPLAY_FRAME_SAMPLES, chunk.length)));
        }
      };
      if (pcm) {
        for (let offset = 0; offset < pcm.length; offset += REPLAY_FRAME_SAMPLES) {
          appendChunk(pcm.subarray(offset, Math.min(offset + REPLAY_FRAME_SAMPLES, pcm.length)));
        }
      } else if (source) {
        const iterator = source[Symbol.asyncIterator]();
        let streaming = true;
        let sourceExhausted = false;
        let abortListener: (() => void) | undefined;
        const aborted = requestSignal && new Promise<never>((_, reject) => {
          abortListener = () => reject(abortError(requestSignal));
          requestSignal.addEventListener('abort', abortListener, { once: true });
        });
        const completed = done.then(() => ({ kind: 'done' as const }), (error: unknown) => ({ kind: 'error' as const, error }));
        try {
          while (streaming) {
            const next = await Promise.race([
              iterator.next().then((value) => ({ kind: 'next' as const, value })),
              completed,
              ...(aborted ? [aborted.then(() => ({ kind: 'aborted' as const }))] : []),
            ]);
            if (next.kind === 'error') throw next.error;
            if (next.kind === 'done') {
              streaming = false;
              responseEndedEarly = true;
              break;
            }
            if (next.kind === 'aborted') throw abortError(requestSignal!);
            if (next.value.done) {
              streaming = false;
              sourceExhausted = true;
              break;
            }
            appendChunk(next.value.value);
          }
        } catch (error) {
          // A caller abort or local stream failure leaves a partial manual turn on the socket.
          // Retire it so a later replay cannot consume the partial response as its own.
          try { live.cancelTurn(); } catch { /* the session is retired below */ }
          retireSession(id, error instanceof Error ? error : new Error('Qwen face replay stream failed.'));
          throw error;
        } finally {
          if (abortListener) requestSignal?.removeEventListener('abort', abortListener);
          if (!sourceExhausted) void iterator.return?.().catch(() => {});
        }
      }
      if (requestSignal?.aborted) throw abortError(requestSignal);
      if (totalSamples === 0) {
        if (source) {
          try { live.cancelTurn(); } catch { /* the session is retired below */ }
          retireSession(id, new Error('Qwen face replay needs a non-empty finalized audio segment.'));
        }
        throw new Error('Qwen face replay needs a non-empty finalized audio segment.');
      }
      if (!source || !responseEndedEarly) {
        live.endTurn();
        turn.timer = setTimeout(() => {
          if (active === turn) retireSession(id, new Error('Qwen face replay response timed out; the next replay will open a fresh session.'));
        }, timeoutMs);
      }
    } catch (error) {
      if (active === turn) active = null;
      clearTimeout(turn.timer);
      throw error;
    }

    await done;
    if (active === turn) active = null;
    const segments = [...turn.segments.values()];
    if (segments.length === 0) {
      const frameSegments = [...turn.frameSegments.values()];
      if (frameSegments.length !== 1) {
        throw new Error(frameSegments.length === 0
          ? 'Qwen replay completed without a translation segment.'
          : 'Qwen replay returned multiple translation segments; refusing to merge them.');
      }
      const [result] = frameSegments;
      if (!result.closed || !result.text.trim()) throw new Error('Qwen replay returned no complete translation text.');
      return result.text.trim();
    }
    if (segments.length !== 1) {
      throw new Error('Qwen replay returned multiple translation segments; refusing to merge them.');
    }
    const [result] = segments;
    if (!result.closed || !result.text.trim()) throw new Error('Qwen replay returned no complete translation text.');
    return result.text.trim();
  };

  const onLifetimeAbort = () => {
    if (!lifetime.signal.aborted) lifetime.abort(options.signal.reason);
    void stop().catch(() => {});
  };
  options.signal.addEventListener('abort', onLifetimeAbort, { once: true });

  const enqueue = (
    pcm: Int16Array | undefined,
    source: AsyncIterable<Int16Array> | undefined,
    signal: AbortSignal | undefined,
    onText?: (text: string) => void,
  ): Promise<string> => {
    const work = tail.then(() => runTurn(pcm, source, signal, onText));
    tail = work.then(() => undefined, () => undefined);
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };
  const translate = (pcm: Int16Array, signal?: AbortSignal): Promise<string> => enqueue(pcm, undefined, signal);
  const translateStream = (source: AsyncIterable<Int16Array>, signal: AbortSignal, onText: (text: string) => void): Promise<string> =>
    enqueue(undefined, source, signal, onText);

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    options.signal.removeEventListener('abort', onLifetimeAbort);
    if (!lifetime.signal.aborted) lifetime.abort(new Error('Qwen face replay stopped.'));
    failActive(new Error('Qwen face replay stopped.'));
    stopping = (async () => {
      let opened: AdapterSession | null = session;
      if (opening) {
        try {
          opened = await opening;
        } catch {
          opened = session;
        }
      }
      if (opened) await opened.stop();
    })();
    return stopping;
  };

  return { translate, translateStream, stop };
}
