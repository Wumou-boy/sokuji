import { describe, expect, it, vi } from 'vitest';
import { recordEvents } from '../../lib/contract/events';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import type { TranslateConfig } from './config';
import { CaptionSegments } from './captionSegments';

const silence: TranslateConfig['silence'] = { sourceMs: 500, translationMs: 500, deferMidSentence: false };

function captions(options: Partial<ConstructorParameters<typeof CaptionSegments>[0]> = {}) {
  const { clock } = trackedClock();
  const { events, log } = recordEvents();
  const translate = options.translate ?? vi.fn(async (text: string) => `译：${text}`);
  const onFailure = vi.fn();
  const value = new CaptionSegments({
    clock, silence, sink: events, detectParticipantLanguage: true,
    targetLanguage: 'zh', translate, onFailure,
    ...options,
  });
  return { value, clock, log, translate, onFailure };
}

describe('CaptionSegments', () => {
  it('translates only a closed source caption and keeps its exact origin', async () => {
    const h = captions();
    h.value.input('The meeting starts at three.');
    expect(h.translate).not.toHaveBeenCalled();

    h.clock.advance(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.translate).toHaveBeenCalledWith('The meeting starts at three.', 'en', expect.any(AbortSignal));
    const source = h.log.find((e) => e.kind === 'segmentOpened' && e.payload.side === 'source');
    const translated = h.log.find((e) => e.kind === 'segmentOpened' && e.payload.side === 'translation');
    expect(source?.kind === 'segmentOpened' && source.payload.origin).toBe('s1');
    expect(translated).toMatchObject({ kind: 'segmentOpened', payload: { ref: -1, side: 'translation', origin: 's1' } });
    expect(h.log.some((e) => e.kind === 'segmentClosed' && e.payload.ref === -1)).toBe(true);
  });

  it('keeps same-target Chinese as the source only and translates ambiguous short speech as auto', async () => {
    const h = captions({ detectParticipantLanguage: false });
    h.value.input('明天早上九点在会议室集合。');
    h.clock.advance(500);
    await Promise.resolve();
    expect(h.translate).not.toHaveBeenCalled();

    h.value.input('好');
    h.clock.advance(500);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.translate).toHaveBeenCalledWith('好', 'auto', expect.any(AbortSignal));
  });

  it('aborts pending translation on stop and preserves the closed source', async () => {
    let resolve!: (text: string) => void;
    let signal: AbortSignal | undefined;
    const translate = vi.fn((_text: string, _language: string, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<string>((r) => { resolve = r; });
    });
    const h = captions({ translate });
    h.value.input('A stable English caption.');
    h.clock.advance(500);
    await Promise.resolve();

    h.value.stop();
    resolve('late translation');
    await Promise.resolve();
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    expect(h.log.some((e) => e.kind === 'segmentText' && e.payload.text === 'A stable English caption.')).toBe(true);
    expect(h.log.some((e) => e.kind === 'segmentText' && e.payload.text === 'late translation')).toBe(false);
  });
});
