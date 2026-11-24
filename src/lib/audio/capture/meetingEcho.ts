import { SAMPLE_RATE } from '../../contract/adapter';

const MAX_DELAY_SAMPLES = Math.round(SAMPLE_RATE * 0.6);
const MAX_MIC_SAMPLES = Math.round(SAMPLE_RATE * 0.36);
const HISTORY_SIZE = MAX_DELAY_SAMPLES + MAX_MIC_SAMPLES;
const MAX_REFERENCE_GAP_MS = 250;
const DECIMATION = 8;
const MIN_POWER = 64 ** 2;
const MIN_CORRELATION = 0.9;

/** Subtract a strongly matching copy of the meeting audio from the outgoing mic.
 * Chromium's echo canceller stays in front of this stage. Ambiguous chunks pass
 * through unchanged, and a matched chunk keeps its uncorrelated local speech.
 */
export function createMeetingEchoReduction(now: () => number = () => performance.now()) {
  // Mirror the ring so a search window is contiguous even across a wrap.
  const history = new Int16Array(2 * HISTORY_SIZE);
  const reference = new Float64Array(Math.ceil(HISTORY_SIZE / DECIMATION));
  const referencePower = new Float64Array(reference.length + 1);
  const mic = new Float64Array(Math.ceil(MAX_MIC_SAMPLES / DECIMATION));
  let head = 0;
  let available = 0;
  let updatedAt = -Infinity;

  const reset = () => {
    head = 0;
    available = 0;
    updatedAt = -Infinity;
  };

  function pushReference(pcm: Int16Array) {
    if (!pcm.length) return;
    const timestamp = now();
    if (timestamp - updatedAt > MAX_REFERENCE_GAP_MS) reset();
    updatedAt = timestamp;
    for (const sample of pcm) {
      history[head] = history[head + HISTORY_SIZE] = sample;
      if (++head === HISTORY_SIZE) head = 0;
    }
    available = Math.min(available + pcm.length, HISTORY_SIZE);
  }

  function reduce(pcm: Int16Array): Int16Array {
    const size = pcm.length;
    if (size < 160 || size > MAX_MIC_SAMPLES || available < size || now() - updatedAt > MAX_REFERENCE_GAP_MS) return pcm;
    const end = head + HISTORY_SIZE;
    const latest = end - size;
    const first = end - Math.min(available, size + MAX_DELAY_SAMPLES);
    const micBlocks = Math.floor(size / DECIMATION);
    const refBlocks = Math.floor((end - first) / DECIMATION);
    let micEnergy = 0;
    for (let i = 0; i < micBlocks; i++) {
      let sum = 0;
      for (let k = 0; k < DECIMATION; k++) sum += pcm[i * DECIMATION + k];
      mic[i] = sum / DECIMATION;
      micEnergy += mic[i] ** 2;
    }
    if (micEnergy < micBlocks * MIN_POWER) return pcm;
    for (let i = 0; i < refBlocks; i++) {
      let sum = 0;
      for (let k = 0; k < DECIMATION; k++) sum += history[first + i * DECIMATION + k];
      reference[i] = sum / DECIMATION;
      referencePower[i + 1] = referencePower[i] + reference[i] ** 2;
    }
    let bestBlock = -1;
    let bestScore = 0;
    for (let start = 0; start <= refBlocks - micBlocks; start++) {
      const energy = referencePower[start + micBlocks] - referencePower[start];
      if (energy < micBlocks * MIN_POWER) continue;
      let dot = 0;
      for (let i = 0; i < micBlocks; i++) dot += mic[i] * reference[start + i];
      const score = dot * dot / (micEnergy * energy);
      if (score > bestScore) {
        bestBlock = start;
        bestScore = score;
      }
    }
    if (bestBlock < 0 || bestScore < 0.6) return pcm;

    const center = first + bestBlock * DECIMATION;
    let power = 0;
    for (const sample of pcm) power += sample ** 2;
    let bestPosition = -1;
    let gain = 0;
    bestScore = MIN_CORRELATION ** 2;
    for (let start = Math.max(first, center - DECIMATION); start <= Math.min(latest, center + DECIMATION); start++) {
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < size; i++) {
        const sample = history[start + i];
        dot += pcm[i] * sample;
        energy += sample ** 2;
      }
      if (energy < size * MIN_POWER || Math.abs(dot) > 3 * energy) continue;
      const score = dot * dot / (power * energy);
      if (score > bestScore) {
        bestPosition = start;
        bestScore = score;
        gain = dot / energy;
      }
    }
    if (bestPosition < 0) return pcm;

    const residual = new Int16Array(size);
    const fadeSamples = SAMPLE_RATE / 1_000;
    for (let i = 0; i < size; i++) {
      const fade = Math.min(1, i / fadeSamples, (size - 1 - i) / fadeSamples);
      const sample = Math.round(pcm[i] - fade * gain * history[bestPosition + i]);
      residual[i] = Math.max(-32768, Math.min(32767, sample));
    }
    return residual;
  }

  return { pushReference, reduce, reset };
}
