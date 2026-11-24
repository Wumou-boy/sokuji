/**
 * Bounded PCM history for a Qwen LiveTranslate session. Offsets reported by
 * `speech_started` / `speech_stopped` are relative to the audio stream that
 * reached the socket, so callers must append only successfully sent PCM.
 */
export const QWEN_AUDIO_HISTORY_MS = 120_000;
export const QWEN_AUDIO_READ_WAIT_MS = 3_000;
export const QWEN_AUDIO_MAX_SEGMENT_MS = 30_000;
const MAX_TRACKED_TURNS = 512;
const PCM_BLOCK_SAMPLES = 4_096;
const STREAM_TRAILING_GUARD_MS = 400;

export class QwenTurnAudioError extends Error {
  constructor(message: string, readonly code: 'missing_timestamp' | 'not_found' | 'history_expired' | 'invalid_range' | 'too_long' | 'timeout' | 'aborted' | 'disposed' | 'connection_reset') {
    super(message);
    this.name = 'QwenTurnAudioError';
  }
}

interface AudioChunk { start: number; end: number; offset: number; used: number; pcm: Int16Array }
interface Turn { start?: number; end?: number; failure?: QwenTurnAudioError }
interface Waiter {
  resolve(pcm: Int16Array): void;
  reject(error: QwenTurnAudioError): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}
interface StreamSubscription { wake?: () => void; failure?: QwenTurnAudioError; timer?: ReturnType<typeof setTimeout> }

/**
 * Maps server item IDs to exact slices of the PCM that was actually sent.
 * The rolling stream history is bounded to two minutes; returned segment PCM
 * is copied and remains valid when the stream resets or this buffer is disposed.
 */
export class QwenTurnAudioBuffer {
  private chunks: AudioChunk[] = [];
  private turns = new Map<string, Turn>();
  private waiters = new Map<string, Set<Waiter>>();
  private streams = new Map<string, Set<StreamSubscription>>();
  private sampleOffset = 0;
  private disposed = false;
  private readonly historySamples: number;
  private readonly maxSegmentSamples: number;

  constructor(
    private readonly sampleRate = 24_000,
    historyMs = QWEN_AUDIO_HISTORY_MS,
    private readonly readWaitMs = QWEN_AUDIO_READ_WAIT_MS,
    private readonly maxSegmentMs = QWEN_AUDIO_MAX_SEGMENT_MS,
  ) {
    this.historySamples = Math.floor(sampleRate * historyMs / 1000);
    this.maxSegmentSamples = Math.floor(sampleRate * maxSegmentMs / 1000);
  }

  /** Called only after appendFrame(pcm) has been accepted by WebSocket.send. */
  append(pcm: Int16Array): void {
    if (this.disposed || pcm.length === 0) return;
    const start = this.sampleOffset;
    let written = 0;
    while (written < pcm.length) {
      let chunk = this.chunks[this.chunks.length - 1];
      if (!chunk || chunk.offset + chunk.used === chunk.pcm.length) {
        chunk = { start: start + written, end: start + written, offset: 0, used: 0, pcm: new Int16Array(PCM_BLOCK_SAMPLES) };
        this.chunks.push(chunk);
      }
      const count = Math.min(pcm.length - written, chunk.pcm.length - chunk.offset - chunk.used);
      chunk.pcm.set(pcm.subarray(written, written + count), chunk.offset + chunk.used);
      chunk.used += count;
      chunk.end += count;
      written += count;
    }
    const end = start + pcm.length;
    this.sampleOffset = end;
    this.trimHistory();
    this.notifyStreams();
  }

  speechStarted(itemId: string, audioStartMs: unknown): void {
    if (this.disposed || !itemId) return;
    const turn = this.turn(itemId);
    const start = this.toSampleOffset(audioStartMs);
    if (start === undefined) turn.failure = new QwenTurnAudioError('Qwen did not provide audio_start_ms for this source item.', 'missing_timestamp');
    else turn.start = start;
    this.settle(itemId);
    this.notifyStreams(itemId);
  }

  speechStopped(itemId: string, audioEndMs: unknown): void {
    if (this.disposed || !itemId) return;
    const turn = this.turn(itemId);
    const end = this.toSampleOffset(audioEndMs);
    if (end === undefined) turn.failure = new QwenTurnAudioError('Qwen did not provide audio_end_ms for this source item.', 'missing_timestamp');
    else turn.end = end;
    this.settle(itemId);
    this.notifyStreams(itemId);
  }

  /**
   * Returns an exact, independent PCM16 copy. If speech has started but the
   * stop event has not arrived yet, it waits briefly for that event.
   */
  read(itemId: string, signal?: AbortSignal): Promise<Int16Array> {
    if (this.disposed) return Promise.reject(new QwenTurnAudioError('The Qwen audio buffer was disposed.', 'disposed'));
    if (!itemId) return Promise.reject(new QwenTurnAudioError('The Qwen source item ID is missing.', 'not_found'));
    if (signal?.aborted) return Promise.reject(new QwenTurnAudioError('The Qwen audio read was aborted.', 'aborted'));
    const turn = this.turn(itemId);
    if (turn.failure) return Promise.reject(turn.failure);
    if (turn.end !== undefined) {
      try { return Promise.resolve(this.copyRange(turn)); }
      catch (error) { return Promise.reject(error); }
    }

    return new Promise<Int16Array>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const code = turn.start === undefined ? 'missing_timestamp' : 'timeout';
          this.failWaiter(itemId, waiter, new QwenTurnAudioError(
            turn.start === undefined ? 'Qwen did not provide audio_start_ms for this source item.' : `Qwen did not provide audio_end_ms within ${this.readWaitMs} ms.`,
            code,
          ));
        }, this.readWaitMs),
      };
      if (signal) {
        waiter.signal = signal;
        waiter.abort = () => this.failWaiter(itemId, waiter, new QwenTurnAudioError('The Qwen audio read was aborted.', 'aborted'));
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      const list = this.waiters.get(itemId) ?? new Set<Waiter>();
      list.add(waiter);
      this.waiters.set(itemId, list);
      this.settle(itemId);
    });
  }

  /**
   * Opt-in live PCM for a single Qwen item. Chunks are detached copies, begin
   * at audio_start_ms, and stop at audio_end_ms. Until speech_stopped arrives,
   * a 400 ms wire tail is retained so delayed stop metadata can trim the next
   * speaker's audio. The final tail is released only after its wire offset is
   * present in the appended PCM.
   */
  stream(itemId: string, signal: AbortSignal): AsyncIterable<Int16Array> {
    const buffer = this;
    return (async function* (): AsyncGenerator<Int16Array> {
      if (buffer.disposed) throw new QwenTurnAudioError('The Qwen audio buffer was disposed.', 'disposed');
      if (!itemId) throw new QwenTurnAudioError('The Qwen source item ID is missing.', 'not_found');
      if (signal.aborted) throw new QwenTurnAudioError('The Qwen audio stream was aborted.', 'aborted');

      const turn = buffer.turn(itemId);
      const subscription: StreamSubscription = {};
      const list = buffer.streams.get(itemId) ?? new Set<StreamSubscription>();
      list.add(subscription);
      buffer.streams.set(itemId, list);
      const abort = () => {
        subscription.failure = new QwenTurnAudioError('The Qwen audio stream was aborted.', 'aborted');
        if (subscription.timer) clearTimeout(subscription.timer);
        buffer.wake(subscription);
      };
      signal.addEventListener('abort', abort, { once: true });
      let cursor: number | undefined;
      try {
        while (true) {
          if (subscription.failure) throw subscription.failure;
          if (turn.failure) throw turn.failure;
          if (cursor === undefined && turn.start !== undefined) cursor = turn.start;

          if (cursor !== undefined) {
            const earliest = buffer.chunks[0]?.start ?? buffer.sampleOffset;
            if (cursor < earliest) throw new QwenTurnAudioError('The Qwen audio range has expired from the bounded history.', 'history_expired');
            if (turn.end !== undefined) {
              if (turn.end <= turn.start!) throw new QwenTurnAudioError('Qwen returned an invalid audio range.', 'invalid_range');
              if (turn.end - turn.start! > buffer.maxSegmentSamples) throw new QwenTurnAudioError(`The Qwen audio range exceeds ${buffer.maxSegmentMs} ms.`, 'too_long');
              if (turn.end < cursor) throw new QwenTurnAudioError('Qwen returned an invalid audio range behind PCM already streamed.', 'invalid_range');
              if (turn.end === cursor) return;
              if (turn.end <= buffer.sampleOffset) {
                while (cursor < turn.end) {
                  const next = Math.min(turn.end, cursor + PCM_BLOCK_SAMPLES);
                  const piece = buffer.copySamples(cursor, next);
                  cursor = next;
                  yield piece;
                  if (subscription.failure) throw subscription.failure;
                }
                return;
              }
            } else {
              const safeEnd = Math.max(0, buffer.sampleOffset - Math.floor(buffer.sampleRate * STREAM_TRAILING_GUARD_MS / 1000));
              if (safeEnd - turn.start! > buffer.maxSegmentSamples) throw new QwenTurnAudioError(`The Qwen audio range exceeds ${buffer.maxSegmentMs} ms.`, 'too_long');
              if (cursor < safeEnd) {
                const next = Math.min(safeEnd, cursor + PCM_BLOCK_SAMPLES);
                const piece = buffer.copySamples(cursor, next);
                cursor = next;
                yield piece;
                continue;
              }
            }
          }

          await new Promise<void>((resolve) => {
            subscription.wake = () => {
              if (subscription.timer) clearTimeout(subscription.timer);
              subscription.timer = undefined;
              resolve();
            };
            subscription.timer = setTimeout(() => {
              subscription.failure = new QwenTurnAudioError(
                turn.start === undefined ? 'Qwen did not provide audio_start_ms for this source item.' : 'The Qwen audio stream stopped making progress before completion.',
                turn.start === undefined ? 'missing_timestamp' : 'timeout',
              );
              buffer.wake(subscription);
            }, buffer.readWaitMs);
          });
        }
      } finally {
        signal.removeEventListener('abort', abort);
        if (subscription.timer) clearTimeout(subscription.timer);
        subscription.wake = undefined;
        list.delete(subscription);
        if (list.size === 0) buffer.streams.delete(itemId);
      }
    })();
  }

  /** A new provider connection has a new offset clock; pending old reads fail explicitly. */
  resetStream(): void {
    if (this.disposed) return;
    this.rejectAll(new QwenTurnAudioError('The Qwen connection reset before this audio could be copied.', 'connection_reset'));
    this.rejectStreams(new QwenTurnAudioError('The Qwen connection reset before this audio could be streamed.', 'connection_reset'));
    this.chunks = [];
    this.turns.clear();
    this.sampleOffset = 0;
  }

  /** Releases retained PCM and rejects reads that have not completed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new QwenTurnAudioError('The Qwen audio buffer was disposed.', 'disposed'));
    this.rejectStreams(new QwenTurnAudioError('The Qwen audio buffer was disposed.', 'disposed'));
    this.chunks = [];
    this.turns.clear();
    this.sampleOffset = 0;
  }

  private turn(itemId: string): Turn {
    const existing = this.turns.get(itemId);
    if (existing) return existing;
    const created: Turn = {};
    this.turns.set(itemId, created);
    this.pruneTurns();
    return created;
  }

  private toSampleOffset(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * this.sampleRate / 1000);
  }

  private settle(itemId: string): void {
    const list = this.waiters.get(itemId);
    if (!list?.size) return;
    const turn = this.turns.get(itemId);
    if (!turn) return;
    if (turn.failure) {
      for (const waiter of [...list]) this.failWaiter(itemId, waiter, turn.failure);
    } else if (turn.start !== undefined && turn.end !== undefined) {
      for (const waiter of [...list]) {
        try { this.finishWaiter(itemId, waiter, this.copyRange(turn)); }
        catch (error) { this.failWaiter(itemId, waiter, error as QwenTurnAudioError); }
      }
    }
  }

  private copyRange(turn: Turn): Int16Array {
    const { start, end } = turn;
    if (start === undefined || end === undefined) throw new QwenTurnAudioError('Qwen did not provide complete audio timestamps for this source item.', 'missing_timestamp');
    if (end <= start || end > this.sampleOffset) throw new QwenTurnAudioError('Qwen returned an invalid audio range.', 'invalid_range');
    if (end - start > this.maxSegmentSamples) throw new QwenTurnAudioError(`The Qwen audio range exceeds ${this.maxSegmentMs} ms.`, 'too_long');
    const earliest = this.chunks[0]?.start ?? this.sampleOffset;
    if (start < earliest) throw new QwenTurnAudioError('The Qwen audio range has expired from the bounded history.', 'history_expired');
    return this.copySamples(start, end);
  }

  private copySamples(start: number, end: number): Int16Array {
    const output = new Int16Array(end - start);
    let written = 0;
    for (const chunk of this.chunks) {
      if (chunk.end <= start || chunk.start >= end) continue;
      const from = Math.max(start, chunk.start);
      const to = Math.min(end, chunk.end);
      const piece = chunk.pcm.subarray(chunk.offset + from - chunk.start, chunk.offset + to - chunk.start);
      output.set(piece, from - start);
      written += piece.length;
    }
    if (written !== output.length) throw new QwenTurnAudioError('The Qwen audio range is not fully present in the sent stream.', 'history_expired');
    return output;
  }

  private trimHistory(): void {
    const cutoff = Math.max(0, this.sampleOffset - this.historySamples);
    while (this.chunks.length > 0 && this.chunks[0].end <= cutoff) this.chunks.shift();
    const first = this.chunks[0];
    if (first && first.start < cutoff) {
      const trim = cutoff - first.start;
      first.start = cutoff;
      first.offset += trim;
      first.used -= trim;
    }
    for (const [itemId, turn] of this.turns) {
      if (turn.start !== undefined && turn.start < cutoff) {
        const error = new QwenTurnAudioError('The Qwen audio range has expired from the bounded history.', 'history_expired');
        for (const waiter of [...(this.waiters.get(itemId) ?? [])]) this.failWaiter(itemId, waiter, error);
        turn.failure = error;
        this.failStreams(itemId, error);
      } else if (turn.end !== undefined && turn.end <= cutoff && !this.waiters.has(itemId)) {
        this.turns.delete(itemId);
      }
    }
  }

  private pruneTurns(): void {
    while (this.turns.size > MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      const turn = this.turns.get(oldest);
      const waiters = this.waiters.get(oldest);
      const streams = this.streams.get(oldest);
      if (waiters?.size) {
        const error = new QwenTurnAudioError('The Qwen audio item exceeded the bounded metadata limit.', 'history_expired');
        for (const waiter of [...waiters]) this.failWaiter(oldest, waiter, error);
      }
      if (streams?.size) this.failStreams(oldest, new QwenTurnAudioError('The Qwen audio item exceeded the bounded metadata limit.', 'history_expired'));
      this.turns.delete(oldest);
      if (turn === undefined) continue;
    }
  }

  private finishWaiter(itemId: string, waiter: Waiter, pcm: Int16Array): void {
    this.removeWaiter(itemId, waiter);
    waiter.resolve(pcm);
  }

  private failWaiter(itemId: string, waiter: Waiter, error: QwenTurnAudioError): void {
    this.removeWaiter(itemId, waiter);
    waiter.reject(error);
  }

  private removeWaiter(itemId: string, waiter: Waiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    const list = this.waiters.get(itemId);
    list?.delete(waiter);
    if (list?.size === 0) this.waiters.delete(itemId);
  }

  private rejectAll(error: QwenTurnAudioError): void {
    for (const [itemId, list] of this.waiters) for (const waiter of [...list]) this.failWaiter(itemId, waiter, error);
    this.waiters.clear();
  }

  private wake(subscription: StreamSubscription): void {
    const wake = subscription.wake;
    subscription.wake = undefined;
    wake?.();
  }

  private notifyStreams(itemId?: string): void {
    if (itemId !== undefined) {
      for (const subscription of this.streams.get(itemId) ?? []) this.wake(subscription);
      return;
    }
    for (const [activeItemId, group] of this.streams) {
      // Audio appended before this item's speech_started event cannot resolve
      // its missing timestamp, so it must not keep the idle deadline alive.
      if (this.turns.get(activeItemId)?.start === undefined) continue;
      for (const subscription of group) this.wake(subscription);
    }
  }

  private failStreams(itemId: string, error: QwenTurnAudioError): void {
    for (const subscription of this.streams.get(itemId) ?? []) {
      subscription.failure = error;
      this.wake(subscription);
    }
  }

  private rejectStreams(error: QwenTurnAudioError): void {
    for (const itemId of this.streams.keys()) this.failStreams(itemId, error);
  }
}
