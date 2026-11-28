import { describe, expect, it } from 'vitest';
import { SpeakerClusters } from './speakerClusters';

describe('SpeakerClusters', () => {
  it('keeps a stable id for a close speaker and seeds an obviously distinct speaker', () => {
    const clusters = new SpeakerClusters();
    expect(clusters.assign(new Float32Array([1, 0]))).toBe(0);
    expect(clusters.assign(new Float32Array([0.99, 0.02]))).toBe(0);
    expect(clusters.assign(new Float32Array([0, 1]))).toBe(1);
    expect(clusters.speakerCount).toBe(2);
  });

  it('leaves ambiguous similarities unassigned and does not let them move a centroid', () => {
    const clusters = new SpeakerClusters({ matchThreshold: 0.8, newSpeakerThreshold: 0.2 });
    expect(clusters.assign(new Float32Array([1, 0]))).toBe(0);
    expect(clusters.assign(new Float32Array([0.6, 0.8]))).toBeUndefined();
    expect(clusters.assign(new Float32Array([0.99, 0.01]))).toBe(0);
  });

  it('rejects invalid embeddings and resets session-local IDs', () => {
    const clusters = new SpeakerClusters();
    expect(clusters.assign(new Float32Array([0, 0]))).toBeUndefined();
    expect(clusters.assign(new Float32Array([Number.NaN, 1]))).toBeUndefined();
    expect(clusters.assign(new Float32Array([1, 0]))).toBe(0);
    clusters.reset();
    expect(clusters.speakerCount).toBe(0);
    expect(clusters.assign(new Float32Array([0, 1]))).toBe(0);
  });

  it('caps speaker creation and validates option values', () => {
    const clusters = new SpeakerClusters({ maxSpeakers: 1 });
    expect(clusters.assign(new Float32Array([1, 0]))).toBe(0);
    expect(clusters.assign(new Float32Array([0, 1]))).toBeUndefined();
    expect(() => new SpeakerClusters({ matchThreshold: 0.2, newSpeakerThreshold: 0.4 })).toThrow(RangeError);
  });
});
