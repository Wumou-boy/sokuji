import { describe, expect, it } from 'vitest';
import { computeCampPlusFeatures } from './speakerEmbeddingFeatures';

describe('computeCampPlusFeatures', () => {
  it('returns 80 log-mel bins per 10 ms snipped frame and removes per-bin means', () => {
    const pcm = Float32Array.from({ length: 16_000 }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 220 * i / 16_000));
    const result = computeCampPlusFeatures(pcm, 16_000);
    expect(result.frames).toBe(1 + Math.floor((pcm.length - 400) / 160));
    expect(result.data).toHaveLength(result.frames * 80);
    for (let b = 0; b < 80; b++) {
      let mean = 0;
      for (let f = 0; f < result.frames; f++) mean += result.data[f * 80 + b];
      expect(mean / result.frames).toBeCloseTo(0, 5);
    }
    expect(Array.from(result.data).every(Number.isFinite)).toBe(true);
  });

  it('rejects the wrong sample rate and clips shorter than one frame', () => {
    expect(() => computeCampPlusFeatures(new Float32Array(1000), 24_000)).toThrow(/16000/);
    expect(() => computeCampPlusFeatures(new Float32Array(399), 16_000)).toThrow(/shorter/);
  });
});
