import { describe, expect, it } from 'vitest';
import { createMeetingEchoReduction } from './meetingEcho';

function speechLike(size: number, seed: number): Int16Array {
  let sample = 0;
  return Int16Array.from({ length: size }, (_, i) => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    sample = 0.94 * sample + (seed / 4294967296 - 0.5) * 4800;
    return Math.round(sample * (0.6 + 0.35 * Math.sin(i / 900)));
  });
}

function errorEnergy(signal: Int16Array, expected: Int16Array): number {
  return signal.reduce((energy, sample, i) => energy + (sample - expected[i]) ** 2, 0);
}

describe('reducing meeting playback in the microphone', () => {
  it('removes most of a delayed copy from a live reference, including across a history wrap', () => {
    const reduction = createMeetingEchoReduction(() => 0);
    const reference = speechLike(30_000, 9);
    reduction.pushReference(reference);
    const start = reference.length - 1851 - 1_920;
    const echo = Int16Array.from(reference.subarray(start, start + 1_920), (sample) => sample * 0.8);
    const reduced = reduction.reduce(echo);
    const quiet = new Int16Array(echo.length);
    expect(errorEnergy(reduced, quiet) / errorEnergy(echo, quiet)).toBeLessThan(0.1);
  });

  it('passes through independent speech, even while the other side is playing audio', () => {
    const reduction = createMeetingEchoReduction(() => 0);
    const reference = speechLike(8_000, 9);
    reduction.pushReference(reference);
    const local = speechLike(1_920, 32);
    expect(reduction.reduce(local)).toBe(local);
  });

  it('preserves local speech in a microphone chunk with strong playback bleed', () => {
    const reduction = createMeetingEchoReduction(() => 0);
    const reference = speechLike(24_000, 39);
    reduction.pushReference(reference);
    const local = Int16Array.from(speechLike(1_920, 29), (sample) => sample * 0.3);
    const mixed = Int16Array.from(local, (sample, i) => sample + reference[18_027 + i] * 0.9);
    const reduced = reduction.reduce(mixed);
    expect(errorEnergy(reduced, local) / errorEnergy(mixed, local)).toBeLessThan(0.12);
    expect(errorEnergy(reduced, local)).toBeLessThan(errorEnergy(new Int16Array(local.length), local));
  });

  it('leaves the mic alone without a fresh reference', () => {
    let time = 0;
    const reduction = createMeetingEchoReduction(() => time);
    const local = speechLike(1_920, 77);
    expect(reduction.reduce(local)).toBe(local);
    reduction.pushReference(local);
    time += 500;
    expect(reduction.reduce(local)).toBe(local);
    reduction.pushReference(local);
    reduction.reset();
    expect(reduction.reduce(local)).toBe(local);
  });
});
