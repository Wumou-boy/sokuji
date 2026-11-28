/** Kaldi-compatible 16 kHz, 80-bin FBank front end for the pinned CAM++ model. */

const SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 400; // 25 ms
const FRAME_SHIFT = 160; // 10 ms
const FFT_SIZE = 512;
const NUM_BINS = 80;
const SPECTRUM_BINS = FFT_SIZE / 2 + 1;
const LOW_FREQUENCY = 20;
const HIGH_FREQUENCY = SAMPLE_RATE / 2;
const PREEMPHASIS = 0.97;

interface Tables {
  window: Float64Array;
  cos: Float64Array;
  sin: Float64Array;
  melWeights: Float64Array;
}

let tables: Tables | undefined;

/**
 * Computes Kaldi-native-fbank-style log energies from normalized float PCM.
 * Matches sherpa-onnx's CAM++ reference: 25 ms Povey frames, snip_edges,
 * dither 0, 80 HTK-mel bins, then per-bin utterance mean normalization.
 */
export function computeCampPlusFeatures(pcm: Float32Array, sampleRate: number): { data: Float32Array; frames: number } {
  if (sampleRate !== SAMPLE_RATE) throw new RangeError(`CAM++ features require ${SAMPLE_RATE} Hz PCM`);
  const frames = Math.floor((pcm.length - FRAME_LENGTH) / FRAME_SHIFT) + 1;
  if (frames < 1) throw new RangeError('audio is shorter than one 25 ms feature frame');
  const t = getTables();
  const output = new Float32Array(frames * NUM_BINS);
  const frame = new Float64Array(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(SPECTRUM_BINS);

  for (let f = 0; f < frames; f++) {
    const start = f * FRAME_SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) mean += pcm[start + i];
    mean /= FRAME_LENGTH;

    // Kaldi pre-emphasis is performed in-place from the end so each input
    // sample is read before it is replaced. The first sample is emphasized
    // against itself, as in the standard feature-window implementation.
    for (let i = FRAME_LENGTH - 1; i > 0; i--) {
      frame[i] = ((pcm[start + i] - mean) - PREEMPHASIS * (pcm[start + i - 1] - mean)) * t.window[i];
    }
    frame[0] = ((pcm[start] - mean) * (1 - PREEMPHASIS)) * t.window[0];
    frame.fill(0, FRAME_LENGTH);
    re.set(frame);
    im.fill(0);
    fftInPlace(re, im);
    for (let k = 0; k < SPECTRUM_BINS; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    for (let bin = 0; bin < NUM_BINS; bin++) {
      let energy = 0;
      const base = bin * SPECTRUM_BINS;
      for (let k = 0; k < SPECTRUM_BINS; k++) energy += t.melWeights[base + k] * power[k];
      output[f * NUM_BINS + bin] = Math.log(Math.max(energy, 1e-10));
    }
  }

  // 3D-Speaker's exported CAM++ graph uses global-mean input normalization.
  const means = new Float64Array(NUM_BINS);
  for (let f = 0; f < frames; f++) {
    const base = f * NUM_BINS;
    for (let b = 0; b < NUM_BINS; b++) means[b] += output[base + b];
  }
  for (let b = 0; b < NUM_BINS; b++) means[b] /= frames;
  for (let f = 0; f < frames; f++) {
    const base = f * NUM_BINS;
    for (let b = 0; b < NUM_BINS; b++) output[base + b] -= means[b];
  }
  return { data: output, frames };
}

function getTables(): Tables {
  if (tables) return tables;
  const window = new Float64Array(FRAME_LENGTH);
  for (let n = 0; n < FRAME_LENGTH; n++) {
    window[n] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FRAME_LENGTH - 1)), 0.85);
  }
  const cos = new Float64Array(FFT_SIZE / 2);
  const sin = new Float64Array(FFT_SIZE / 2);
  for (let i = 0; i < cos.length; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE);
    sin[i] = Math.sin((2 * Math.PI * i) / FFT_SIZE);
  }

  const mel = (hz: number) => 1127 * Math.log1p(hz / 700);
  const lowMel = mel(LOW_FREQUENCY);
  const highMel = mel(HIGH_FREQUENCY);
  const step = (highMel - lowMel) / (NUM_BINS + 1);
  const melWeights = new Float64Array(NUM_BINS * SPECTRUM_BINS);
  for (let bin = 0; bin < NUM_BINS; bin++) {
    const left = lowMel + bin * step;
    const center = left + step;
    const right = center + step;
    for (let k = 0; k < SPECTRUM_BINS; k++) {
      const hz = (k * SAMPLE_RATE) / FFT_SIZE;
      const m = mel(hz);
      const weight = m < left || m > right ? 0 : m <= center ? (m - left) / step : (right - m) / step;
      melWeights[bin * SPECTRUM_BINS + k] = Math.max(weight, 0);
    }
  }
  tables = { window, cos, sin, melWeights };
  return tables;
}

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const t = getTables();
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0; j < half; j++) {
        const twiddle = j * stride;
        const tr = re[start + j + half] * t.cos[twiddle] + im[start + j + half] * t.sin[twiddle];
        const ti = im[start + j + half] * t.cos[twiddle] - re[start + j + half] * t.sin[twiddle];
        re[start + j + half] = re[start + j] - tr;
        im[start + j + half] = im[start + j] - ti;
        re[start + j] += tr;
        im[start + j] += ti;
      }
    }
  }
}
