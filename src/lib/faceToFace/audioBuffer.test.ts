import { afterEach, describe, expect, it, vi } from 'vitest';
import { QwenTurnAudioBuffer, QwenTurnAudioError } from './audioBuffer';

describe('Qwen turn audio buffer', () => {
  afterEach(() => vi.useRealTimers());

  it('maps provider ranges to absolute time across a pause and resets its clock on reconnect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);

    vi.advanceTimersByTime(1_000);
    buffer.append(new Int16Array(1_000));
    buffer.speechStarted('first', 250);
    vi.advanceTimersByTime(5_000);
    buffer.append(new Int16Array(1_000));
    buffer.speechStopped('first', 1_250);
    expect(buffer.timeRange('first')).toEqual({ startAt: 250, endAt: 5_250, timeKind: 'given' });

    buffer.resetStream();
    expect(buffer.timeRange('first')).toEqual({ timeKind: 'unknown' });
    vi.advanceTimersByTime(1_000);
    buffer.append(new Int16Array(1_000));
    buffer.speechStarted('after-reconnect', 300);
    buffer.speechStopped('after-reconnect', 900);
    expect(buffer.timeRange('after-reconnect')).toEqual({ startAt: 6_300, endAt: 6_900, timeKind: 'given' });
    buffer.dispose();
  });

  it('labels arrival-offset fallback ranges as estimated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    vi.advanceTimersByTime(500);
    buffer.append(new Int16Array(500));
    buffer.speechStarted('estimated', Number.NaN);
    vi.advanceTimersByTime(1_000);
    buffer.append(new Int16Array(500));
    buffer.speechStopped('estimated', undefined);
    expect(buffer.timeRange('estimated')).toEqual({ startAt: 500, endAt: 1_500, timeKind: 'estimated' });
    buffer.dispose();
  });

  it('slices exact sample offsets from appended wire PCM and returns a detached copy', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    buffer.append(new Int16Array(10).fill(1));
    buffer.speechStarted('item-1', 4);
    buffer.append(new Int16Array(10).fill(2));
    buffer.speechStopped('item-1', 14);

    const audio = await buffer.read('item-1');
    expect([...audio]).toEqual([...new Int16Array(6).fill(1), ...new Int16Array(4).fill(2)]);
    buffer.resetStream();
    expect(audio.length).toBe(10);
    expect(audio[0]).toBe(1);
    buffer.dispose();
  });

  it('waits briefly for speech_stopped when a source segment arrives first', async () => {
    vi.useFakeTimers();
    const buffer = new QwenTurnAudioBuffer(1_000, 1_000, 100, 500);
    buffer.append(new Int16Array(8).fill(7));
    buffer.speechStarted('item-2', 2);
    const result = buffer.read('item-2');
    buffer.append(new Int16Array(8).fill(8));
    buffer.speechStopped('item-2', 12);
    await expect(result).resolves.toEqual(new Int16Array([...new Int16Array(6).fill(7), ...new Int16Array(4).fill(8)]));
    buffer.dispose();
  });

  it('streams buffered and newly appended samples from the exact start and trims at the delayed stop', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    const beforeAndDuring = Int16Array.from({ length: 800 }, (_, index) => index);
    buffer.append(beforeAndDuring);
    buffer.speechStarted('live', 100);
    const controller = new AbortController();
    const iterator = buffer.stream('live', controller.signal)[Symbol.asyncIterator]();

    const buffered = await iterator.next();
    expect([...buffered.value!]).toEqual(Array.from({ length: 300 }, (_, index) => index + 100));

    const during = iterator.next();
    buffer.append(Int16Array.from({ length: 200 }, (_, index) => index + 800));
    const streamed = await during;
    expect([...streamed.value!]).toEqual(Array.from({ length: 200 }, (_, index) => index + 400));

    buffer.speechStopped('live', 800);
    const final = await iterator.next();
    expect([...final.value!]).toEqual(Array.from({ length: 200 }, (_, index) => index + 600));
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    buffer.dispose();
  });

  it('replays a completed buffered item when streaming is subscribed late', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    buffer.append(Int16Array.from({ length: 10 }, (_, index) => index));
    buffer.speechStarted('late', 2);
    buffer.speechStopped('late', 7);
    const iterator = buffer.stream('late', new AbortController().signal)[Symbol.asyncIterator]();
    expect([...((await iterator.next()).value ?? [])]).toEqual([2, 3, 4, 5, 6]);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    buffer.dispose();
  });

  it('clips a delayed stop behind already released PCM and completes the stream', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    buffer.append(new Int16Array(1_000).fill(9));
    buffer.speechStarted('late-stop', 0);
    const iterator = buffer.stream('late-stop', new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.length).toBe(600);
    buffer.speechStopped('late-stop', 500);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    buffer.dispose();
  });

  it('waits for wire PCM when the stop timestamp arrives just ahead of appended audio', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    buffer.speechStopped('race', 5);
    buffer.speechStarted('race', 0);
    const controller = new AbortController();
    const iterator = buffer.stream('race', controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    buffer.append(new Int16Array([11, 12, 13]));
    const stillPending = iterator.next();
    buffer.append(new Int16Array([14, 15]));
    expect([...((await pending).value ?? [])]).toEqual([11, 12, 13, 14, 15]);
    expect(await stillPending).toEqual({ value: undefined, done: true });
    buffer.dispose();
  });

  it('rejects an active stream on abort or connection reset', async () => {
    const abortedBuffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    abortedBuffer.speechStarted('abort', 0);
    const controller = new AbortController();
    const aborted = abortedBuffer.stream('abort', controller.signal)[Symbol.asyncIterator]();
    const next = aborted.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: 'aborted' });
    abortedBuffer.dispose();

    const resetBuffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 2_000);
    resetBuffer.speechStarted('reset', 0);
    const resetIterator = resetBuffer.stream('reset', new AbortController().signal)[Symbol.asyncIterator]();
    const resetNext = resetIterator.next();
    resetBuffer.resetStream();
    await expect(resetNext).rejects.toMatchObject({ code: 'connection_reset' });
    resetBuffer.dispose();
  });

  it('times out when a stopped item never receives its final wire samples', async () => {
    vi.useFakeTimers();
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 50, 2_000);
    buffer.append(new Int16Array([1, 2, 3]));
    buffer.speechStarted('short-wire', 0);
    buffer.speechStopped('short-wire', 5);
    const iterator = buffer.stream('short-wire', new AbortController().signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    buffer.dispose();
  });

  it('bounds an inactive item that never receives a start timestamp', async () => {
    vi.useFakeTimers();
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 50, 2_000);
    const iterator = buffer.stream('inactive', new AbortController().signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    buffer.append(new Int16Array(1));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'missing_timestamp' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    buffer.dispose();
  });

  it('uses local offsets for missing or malformed event timestamps', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 5);
    buffer.append(new Int16Array([1, 2, 3]));
    buffer.speechStarted('fallback', Number.NaN);
    buffer.append(new Int16Array([4, 5]));
    buffer.speechStopped('fallback', undefined);
    expect(buffer.timingOf('fallback')).toBe('estimated');
    await expect(buffer.read('fallback')).resolves.toEqual(new Int16Array([4, 5]));
    buffer.dispose();
  });

  it('streams long speech as bounded PCM chunks without dropping the turn', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 60_000, 100, 5_000);
    buffer.append(new Int16Array(35_000).fill(7));
    buffer.speechStarted('long-live', 0);
    buffer.speechStopped('long-live', 35_000);
    const iterator = buffer.stream('long-live', new AbortController().signal)[Symbol.asyncIterator]();
    let total = 0;
    let largest = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      total += next.value.length;
      largest = Math.max(largest, next.value.length);
    }
    expect(total).toBe(35_000);
    expect(largest).toBeLessThanOrEqual(4_096);
    buffer.dispose();
  });

  it('clips a start ahead of sent PCM to the current local boundary', async () => {
    const buffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 5);
    buffer.append(new Int16Array([1, 2, 3]));
    buffer.speechStarted('ahead', 20);
    buffer.append(new Int16Array([4, 5]));
    buffer.speechStopped('ahead', 5);
    await expect(buffer.read('ahead')).resolves.toEqual(new Int16Array([4, 5]));
    buffer.dispose();
  });

  it('rejects ranges longer than the bounded read limit', async () => {
    const longBuffer = new QwenTurnAudioBuffer(1_000, 10_000, 100, 5);
    longBuffer.append(new Int16Array(10));
    longBuffer.speechStarted('long-live', 0);
    longBuffer.speechStopped('long-live', 10);
    await expect(longBuffer.read('long-live')).rejects.toMatchObject({ code: 'too_long' });
    longBuffer.dispose();
  });

  it('fails explicitly for missing timestamps, expired history, overlong ranges, and a missing stop', async () => {
    const missing = new QwenTurnAudioBuffer(1_000, 100, 10, 50);
    missing.speechStarted('missing', undefined);
    missing.speechStopped('missing', undefined);
    await expect(missing.read('missing')).rejects.toMatchObject({ code: 'invalid_range' });

    const expired = new QwenTurnAudioBuffer(1_000, 10, 10, 50);
    expired.append(new Int16Array(10));
    expired.speechStarted('old', 0);
    expired.speechStopped('old', 10);
    expired.append(new Int16Array(20));
    await expect(expired.read('old')).rejects.toMatchObject({ code: 'history_expired' });

    const tooLong = new QwenTurnAudioBuffer(1_000, 100, 10, 5);
    tooLong.append(new Int16Array(10));
    tooLong.speechStarted('long', 0);
    tooLong.speechStopped('long', 10);
    await expect(tooLong.read('long')).rejects.toMatchObject({ code: 'too_long' });

    vi.useFakeTimers();
    const noStop = new QwenTurnAudioBuffer(1_000, 100, 20, 50);
    noStop.speechStarted('open', 0);
    const pending = noStop.read('open');
    const rejected = expect(pending).rejects.toBeInstanceOf(QwenTurnAudioError);
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    noStop.dispose();
  });
});
