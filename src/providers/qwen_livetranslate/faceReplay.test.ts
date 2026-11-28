import { describe, expect, it, vi } from 'vitest';
import type { AdapterEvents, AdapterSession } from '../../lib/contract/adapter';
import { createQwenFaceReplay, QWEN_FACE_REPLAY_MAX_SAMPLES } from './faceReplay';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the fake adapter turn to start.');
}

function harness() {
  const events: AdapterEvents[] = [];
  const calls: string[] = [];
  const stopped = vi.fn(async () => {});
  const start = vi.fn(async (sink: AdapterEvents) => {
    events.push(sink);
    const session: AdapterSession = {
      info: {},
      beginTurn: () => calls.push('begin'),
      appendAudio: (pcm) => calls.push(`audio:${pcm.length}`),
      endTurn: () => calls.push('end'),
      cancelTurn: () => calls.push('cancel'),
      appendText: () => calls.push('text'),
      stop: stopped,
    };
    return session;
  });
  const replay = createQwenFaceReplay({ start, signal: new AbortController().signal, responseTimeoutMs: 10 });
  const translation = (ref: number, text: string) => {
    const sink = events[events.length - 1];
    sink.segmentOpened({ ref, side: 'translation' });
    sink.segmentText({ ref, text });
    sink.segmentClosed({ ref });
  };
  const done = (status = 'completed') => events[events.length - 1].frame({ direction: 'in', type: 'response.done', payload: { status } });
  return { calls, done, events, replay, start, stopped, translation };
}

describe('Qwen face replay transport', () => {
  it('opens lazily, reuses one manual session, and serializes turns through response.done', async () => {
    const h = harness();
    expect(h.start).not.toHaveBeenCalled();

    const first = h.replay.translate(new Int16Array(24));
    await waitFor(() => h.calls.length === 3);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['begin', 'audio:24', 'end']);

    const second = h.replay.translate(new Int16Array(48));
    expect(h.calls).toHaveLength(3);

    h.translation(1, 'Bonjour');
    h.done();
    await expect(first).resolves.toBe('Bonjour');
    await waitFor(() => h.calls.length === 6);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['begin', 'audio:24', 'end', 'begin', 'audio:48', 'end']);

    h.translation(2, 'こんにちは');
    h.done();
    await expect(second).resolves.toBe('こんにちは');
    await h.replay.stop();
    expect(h.stopped).toHaveBeenCalledTimes(1);
  });

  it('streams audio incrementally, publishes translation snapshots before commit, and starts the timeout after commit', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const controller = new AbortController();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      async function* source() {
        yield new Int16Array(24);
        await gate;
        yield new Int16Array(24);
      }
      const onText = vi.fn();
      const pending = h.replay.translateStream(source(), controller.signal, onText);
      await waitFor(() => h.calls.length === 2);
      expect(h.calls).toEqual(['begin', 'audio:24']);

      h.events[0].segmentOpened({ ref: 9, side: 'translation' });
      h.events[0].segmentText({ ref: 9, text: 'Hel' });
      h.events[0].segmentText({ ref: 9, text: 'Hello' });
      expect(onText.mock.calls).toEqual([['Hel'], ['Hello']]);

      await vi.advanceTimersByTimeAsync(20);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.calls).toEqual(['begin', 'audio:24']);

      release();
      await waitFor(() => h.calls.length === 4);
      expect(h.calls).toEqual(['begin', 'audio:24', 'audio:24', 'end']);
      h.translation(9, 'Hello world');
      h.done();
      await expect(pending).resolves.toBe('Hello world');
      expect(onText.mock.calls).toEqual([['Hel'], ['Hello'], ['Hello world']]);
      await h.replay.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits a continuous source longer than 30 seconds into serialized bounded turns', async () => {
    const h = harness();
    async function* source() {
      yield new Int16Array(QWEN_FACE_REPLAY_MAX_SAMPLES + 4_800).fill(1);
    }
    const pending = h.replay.translateStream(source(), new AbortController().signal, () => {});
    await waitFor(() => h.calls.filter((call) => call === 'end').length === 1);
    const firstTurnSamples = h.calls
      .slice(1)
      .filter((call) => call.startsWith('audio:'))
      .reduce((sum, call) => sum + Number(call.slice('audio:'.length)), 0);
    expect(firstTurnSamples).toBeLessThan(QWEN_FACE_REPLAY_MAX_SAMPLES);
    h.translation(1, 'first part');
    h.done();

    await waitFor(() => h.calls.filter((call) => call === 'end').length === 2);
    h.translation(2, 'second part');
    h.done();
    await expect(pending).resolves.toBe('first part second part');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((call) => call === 'begin')).toHaveLength(2);
    await h.replay.stop();
  });

  it('aborts while the async audio source is still producing and retires that partial turn', async () => {
    const h = harness();
    const controller = new AbortController();
    async function* source() {
      yield new Int16Array([1, 2]);
      await new Promise<void>(() => {});
      yield new Int16Array([3]);
    }
    const pending = h.replay.translateStream(source(), controller.signal, () => {});
    await waitFor(() => h.calls.includes('audio:2'));
    controller.abort(new Error('stream cancelled'));
    await expect(pending).rejects.toThrow('stream cancelled');
    expect(h.calls).toEqual(['begin', 'audio:2', 'cancel']);
    expect(h.stopped).toHaveBeenCalledTimes(1);

    const next = h.replay.translate(new Int16Array([4]));
    await waitFor(() => h.calls.length === 6);
    expect(h.start).toHaveBeenCalledTimes(2);
    h.translation(10, 'fresh');
    h.done();
    await expect(next).resolves.toBe('fresh');
    await h.replay.stop();
  });

  it('stops consuming audio when the server completes the response early', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* source() {
      yield new Int16Array([1]);
      await gate;
      yield new Int16Array([2]);
    }
    const pending = h.replay.translateStream(source(), new AbortController().signal, () => {});
    await waitFor(() => h.calls.length === 2);
    h.translation(11, 'early result');
    h.done();
    await expect(pending).resolves.toBe('early result');
    expect(h.calls).toEqual(['begin', 'audio:1']);
    release();
    await h.replay.stop();
  });

  it('recovers repeated translations from raw Qwen text frames when structured refs are missing', async () => {
    const h = harness();
    const run = async (itemId: string) => {
      async function* source() { yield new Int16Array([1]); }
      const onText = vi.fn();
      const pending = h.replay.translateStream(source(), new AbortController().signal, onText);
      await waitFor(() => h.calls.filter((call) => call === 'end').length === (itemId === 'item-1' ? 1 : 2));
      const sink = h.events[h.events.length - 1];
      sink.frame({ direction: 'in', type: 'response.text.delta', payload: { itemId, delta: '你好' } });
      sink.frame({ direction: 'in', type: 'response.text.done', payload: { itemId, text: '你好' } });
      sink.frame({ direction: 'in', type: 'response.done', payload: { status: 'completed' } });
      await expect(pending).resolves.toBe('你好');
      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText).toHaveBeenCalledWith('你好');
    };

    await run('item-1');
    await run('item-2');
    expect(h.start).toHaveBeenCalledTimes(1);
    await h.replay.stop();
  });

  it('rejects ambiguous raw-frame translations instead of merging item text', async () => {
    const h = harness();
    async function* source() { yield new Int16Array([1]); }
    const pending = h.replay.translateStream(source(), new AbortController().signal, () => {});
    await waitFor(() => h.calls.includes('end'));
    const sink = h.events[0];
    sink.frame({ direction: 'in', type: 'response.text.done', payload: { itemId: 'item-1', text: 'one' } });
    sink.frame({ direction: 'in', type: 'response.text.done', payload: { itemId: 'item-2', text: 'two' } });
    sink.frame({ direction: 'in', type: 'response.done', payload: { status: 'completed' } });
    await expect(pending).rejects.toThrow('multiple translation segments');
    await h.replay.stop();
  });

  it('rejects ambiguous multi-ref responses instead of joining their text', async () => {
    const h = harness();
    const pending = h.replay.translate(new Int16Array([10, 11]));
    await waitFor(() => h.calls.length === 3);
    h.translation(1, 'one');
    h.translation(2, 'two');
    h.done();
    await expect(pending).rejects.toThrow('multiple translation segments');
    await h.replay.stop();
  });

  it('rejects a failed response and an oversized segment, and lets an aborted request avoid opening', async () => {
    const h = harness();
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled before replay'));
    await expect(h.replay.translate(new Int16Array([1]), cancelled.signal)).rejects.toThrow('cancelled before replay');
    expect(h.start).not.toHaveBeenCalled();

    const failed = h.replay.translate(new Int16Array(24));
    await waitFor(() => h.calls.length === 3);
    h.translation(3, 'partial');
    h.done('failed');
    await expect(failed).rejects.toThrow('did not complete (failed)');

    await expect(h.replay.translate(new Int16Array(QWEN_FACE_REPLAY_MAX_SAMPLES))).rejects.toThrow('shorter than 30 seconds');
    await h.replay.stop();
  });

  it('promptly rejects a cancelled in-flight caller but drains its response before the next turn', async () => {
    const h = harness();
    const cancel = new AbortController();
    const first = h.replay.translate(new Int16Array([1]), cancel.signal);
    await waitFor(() => h.calls.length === 3);
    const second = h.replay.translate(new Int16Array([2]));
    cancel.abort(new Error('cancelled by caller'));
    await expect(first).rejects.toThrow('cancelled by caller');
    expect(h.calls).toEqual(['begin', 'audio:1', 'end']);

    h.translation(1, 'discarded');
    h.done();
    await waitFor(() => h.calls.length === 6);
    expect(h.calls).toEqual(['begin', 'audio:1', 'end', 'begin', 'audio:1', 'end']);
    h.translation(2, 'kept');
    h.done();
    await expect(second).resolves.toBe('kept');
    await h.replay.stop();
  });

  it('retires a timed-out connection and ignores its late response while the next turn uses a fresh session', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const first = h.replay.translate(new Int16Array([1]));
      await waitFor(() => h.calls.length === 3);
      const oldEvents = h.events[0];
      const next = h.replay.translate(new Int16Array([2]));

      await vi.advanceTimersByTimeAsync(11);
      await expect(first).rejects.toThrow('response timed out');
      await waitFor(() => h.calls.length === 6);
      expect(h.start).toHaveBeenCalledTimes(2);
      expect(h.calls).toEqual(['begin', 'audio:1', 'end', 'begin', 'audio:1', 'end']);

      oldEvents.segmentOpened({ ref: 1, side: 'translation' });
      oldEvents.segmentText({ ref: 1, text: 'late old answer' });
      oldEvents.segmentClosed({ ref: 1 });
      oldEvents.frame({ direction: 'in', type: 'response.done', payload: { status: 'completed' } });
      await Promise.resolve();
      expect(h.events).toHaveLength(2);

      h.translation(2, 'fresh answer');
      h.done();
      await expect(next).resolves.toBe('fresh answer');
      await h.replay.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens after a transport close and keeps old callbacks isolated', async () => {
    const h = harness();
    const first = h.replay.translate(new Int16Array([1]));
    await waitFor(() => h.calls.length === 3);
    const oldEvents = h.events[0];
    oldEvents.closed({ reason: 'network' });
    await expect(first).rejects.toThrow('session ended');

    const next = h.replay.translate(new Int16Array([2]));
    await waitFor(() => h.calls.length === 6);
    expect(h.start).toHaveBeenCalledTimes(2);
    oldEvents.segmentOpened({ ref: 10, side: 'translation' });
    oldEvents.segmentText({ ref: 10, text: 'stale' });
    oldEvents.frame({ direction: 'in', type: 'response.done', payload: { status: 'completed' } });
    h.translation(11, 'reconnected');
    h.done();
    await expect(next).resolves.toBe('reconnected');
    await h.replay.stop();
  });

  it('waits for a racing session open, then closes that session before stop resolves', async () => {
    let resolveStart!: (session: AdapterSession) => void;
    const start = vi.fn(() => new Promise<AdapterSession>((resolve) => { resolveStart = resolve; }));
    const stopped = vi.fn(async () => {});
    const replay = createQwenFaceReplay({ start: async () => start(), signal: new AbortController().signal });
    const pending = replay.translate(new Int16Array([1]));
    const cancelled = expect(pending).rejects.toThrow('stopped');
    await waitFor(() => start.mock.calls.length === 1);
    const stopping = replay.stop();
    let stopFinished = false;
    void stopping.then(() => { stopFinished = true; });
    await Promise.resolve();
    expect(stopFinished).toBe(false);

    resolveStart({
      info: {},
      beginTurn() {},
      appendAudio() {},
      appendText() {},
      endTurn() {},
      cancelTurn() {},
      stop: stopped,
    });
    await stopping;
    await cancelled;
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
