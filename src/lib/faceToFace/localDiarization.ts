import { SAMPLE_RATE } from '../contract/adapter';
import type { QwenTurnAudioBuffer } from './audioBuffer';
import { SpeakerClusters } from './speakerClusters';
import { SpeakerEmbedder } from './speakerEmbedding';

type Status = 'loading' | 'active' | 'unavailable';
const MIN_SAMPLES = Math.round(SAMPLE_RATE * 1.2);
const MAX_SAMPLES = SAMPLE_RATE * 3;
const MAX_PENDING_TURNS = 8;

export function startLocalDiarization(
  audioBuffer: QwenTurnAudioBuffer,
  signal: AbortSignal,
  onStatus: (status: Status) => void,
  onSpeaker: (itemId: string, number: number) => void,
) {
  const stats = { status: 'loading' as Status, assigned: 0, skipped: 0, errors: 0, inferenceMs: [] as number[] };
  const clusters = new SpeakerClusters();
  let embedder: SpeakerEmbedder | undefined;
  const seen = new Set<string>();
  let consecutiveErrors = 0;
  let pending = 0;
  let disposed = false;
  onStatus('loading');

  const updateStatus = (status: Status) => {
    stats.status = status;
    onStatus(status);
  };
  const unavailable = () => {
    if (disposed || signal.aborted || stats.status === 'unavailable') return;
    embedder?.dispose();
    updateStatus('unavailable');
  };
  const ready = Promise.resolve().then(async () => {
    if (disposed || signal.aborted) return;
    embedder = new SpeakerEmbedder();
    await embedder.ready();
    if (!disposed && !signal.aborted) updateStatus('active');
  }).catch(unavailable);
  let queue = Promise.resolve();

  return {
    stats,
    speechStopped(itemId: string) {
      if (disposed || signal.aborted || stats.status === 'unavailable' || seen.has(itemId)) return;
      seen.add(itemId);
      if (seen.size > 144) seen.delete(seen.values().next().value!);
      if (pending >= MAX_PENDING_TURNS || audioBuffer.timingOf(itemId) !== 'server') {
        stats.skipped += 1;
        return;
      }
      pending += 1;
      const audio = audioBuffer.read(itemId, signal).catch(() => undefined);
      queue = queue.then(async () => {
        const pcm = await audio;
        if (disposed || signal.aborted || stats.status === 'unavailable') return;
        if (!pcm || pcm.length < MIN_SAMPLES) {
          stats.skipped += 1;
          return;
        }
        await ready;
        if (disposed || signal.aborted || stats.status !== 'active' || !embedder) return;
        const length = Math.min(pcm.length, MAX_SAMPLES);
        const offset = Math.floor((pcm.length - length) / 2);
        const clip = Float32Array.from(pcm.subarray(offset, offset + length), (sample) => sample / 32768);
        try {
          const started = performance.now();
          const embedding = await embedder.embed(clip, SAMPLE_RATE);
          if (disposed || signal.aborted) return;
          consecutiveErrors = 0;
          if (stats.inferenceMs.length >= 60) stats.inferenceMs.shift();
          stats.inferenceMs.push(Math.round(performance.now() - started));
          const speaker = clusters.assign(embedding);
          if (speaker === undefined) stats.skipped += 1;
          else {
            stats.assigned += 1;
            onSpeaker(itemId, speaker + 1);
          }
        } catch {
          if (disposed || signal.aborted) return;
          stats.errors += 1;
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) unavailable();
        }
      }).finally(() => { pending -= 1; });
    },
    dispose() {
      disposed = true;
      seen.clear();
      embedder?.dispose();
    },
  };
}
