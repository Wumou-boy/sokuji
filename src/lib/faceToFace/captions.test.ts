import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FaceToFaceCaptions } from './captions';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';

describe('FaceToFaceCaptions', () => {
  beforeEach(() => {
    useFaceToFaceStore.setState({
      phase: 'idle', error: null,
      languages: { first: 'ja', second: 'en' },
      captions: [],
    });
  });

  it('joins a translation that opens and streams before its source, and avoids a duplicate row', async () => {
    const translate = vi.fn();
    const captions = new FaceToFaceCaptions({ first: 'en', second: 'ja' }, translate);
    captions.opened({ ref: 2, side: 'translation', origin: 'h1' });
    captions.text({ ref: 2, text: 'Good morning.', language: 'en' });
    captions.opened({ ref: 1, side: 'source', origin: 'h1', person: 'person-a' });
    captions.opened({ ref: 3, side: 'source', origin: 'h1', person: 'person-a' });
    captions.text({ ref: 1, text: 'おはようございます。', language: 'ja-JP' });
    captions.closed(1);
    captions.closed(2, 'h1');

    await Promise.resolve();
    expect(useFaceToFaceStore.getState().captions).toHaveLength(1);
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      source: 'おはようございます。', sourceLanguage: 'ja-JP', speakerNumber: 1,
      subtitles: { en: 'Good morning.', ja: 'おはようございます。' }, final: true,
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('keeps the estimated source-open cue fixed when later source and translation updates arrive', () => {
    const now = vi.fn().mockReturnValueOnce(10_000).mockReturnValueOnce(10_800);
    const captions = new FaceToFaceCaptions({ first: 'en', second: 'ja' }, undefined, { now });
    captions.opened({ ref: 1, side: 'source', origin: 'source-estimated' });
    captions.text({ ref: 1, text: 'こんにちは', language: 'ja' });
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      startAt: 10_000, timeKind: 'estimated',
    });
    captions.closed(1);
    const beforeTranslation = useFaceToFaceStore.getState().captions[0];
    captions.opened({ ref: 2, side: 'translation', origin: 'source-estimated', target: 'en' });
    captions.text({ ref: 2, text: 'Hello', target: 'en' });
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      startAt: beforeTranslation.startAt,
      endAt: beforeTranslation.endAt,
      timeKind: beforeTranslation.timeKind,
      subtitles: { en: 'Hello', ja: 'こんにちは' },
    });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('upgrades source timing when provider bounds arrive after an early text partial', () => {
    let providerTiming: { startAt?: number; endAt?: number; timeKind: 'given' | 'estimated' | 'unknown' } = { timeKind: 'unknown' };
    const captions = new FaceToFaceCaptions({ first: 'en', second: 'ja' }, undefined, {
      now: () => 20_000,
      timingOf: () => providerTiming,
    });
    captions.opened({ ref: 1, side: 'source', origin: 'late-source-timing' });
    captions.text({ ref: 1, text: 'こんにちは', language: 'ja' });
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({ startAt: 20_000, timeKind: 'estimated' });

    providerTiming = { startAt: 19_900, endAt: 20_500, timeKind: 'given' };
    captions.closed(1);
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      startAt: 19_900, endAt: 20_500, timeKind: 'given', final: true,
    });
  });

  it('refreshes a source caption when VAD stop supplies its end without another text event', () => {
    let providerTiming: { startAt?: number; endAt?: number; timeKind: 'given' | 'estimated' | 'unknown' } = {
      startAt: 30_000, timeKind: 'estimated',
    };
    const captions = new FaceToFaceCaptions({ first: 'en', second: 'ja' }, undefined, {
      timingOf: () => providerTiming,
    });
    captions.opened({ ref: 1, side: 'source', origin: 'stop-without-more-text' });
    captions.text({ ref: 1, text: 'こんにちは', language: 'ja' });
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      startAt: 30_000, timeKind: 'estimated',
    });

    providerTiming = { startAt: 29_950, endAt: 30_800, timeKind: 'given' };
    captions.refreshTiming('stop-without-more-text');
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      startAt: 29_950, endAt: 30_800, timeKind: 'given',
    });
  });

  it('streams the second language as soon as a source item has a known language', async () => {
    const translate = vi.fn((_id: string, _signal: AbortSignal, onText: (text: string) => void) => {
      onText('Good');
      return Promise.resolve('Good morning.');
    });
    const captions = new FaceToFaceCaptions({ first: 'zh', second: 'en' }, translate);
    captions.opened({ ref: 1, side: 'source', origin: 'h2' });
    captions.text({ ref: 1, text: 'おはようございます。', language: 'ja' });
    captions.opened({ ref: 2, side: 'translation', origin: 'h2' });
    captions.text({ ref: 2, text: '早上好。', language: 'zh' });
    expect(translate).toHaveBeenCalledExactlyOnceWith('h2', expect.any(AbortSignal), expect.any(Function), true, 'en', expect.objectContaining({ sourceLanguage: 'ja' }));
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({ final: false, subtitles: { zh: '早上好。', en: 'Good' } });
    captions.closed(1);
    captions.closed(2, 'h2');
    await Promise.resolve();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      subtitles: { zh: '早上好。', en: 'Good morning.' }, final: true,
    });
  });

  it('joins primary translation text when Qwen supplies its source item only at close', () => {
    const replay = vi.fn();
    const captions = new FaceToFaceCaptions({ first: 'zh', second: 'ja' }, replay);
    captions.opened({ ref: 1, side: 'source', origin: 'heard' });
    captions.text({ ref: 1, text: 'おはようございます。', language: 'ja' });
    captions.opened({ ref: 2, side: 'translation' });
    captions.text({ ref: 2, text: '早上好。' });
    captions.closed(2, 'heard');
    captions.closed(1);

    expect(useFaceToFaceStore.getState().captions[0].subtitles).toEqual({ zh: '早上好。', ja: 'おはようございます。' });
    expect(replay).not.toHaveBeenCalled();
  });

  it('recognizes an unselected French source and streams its translation into the other selected language', async () => {
    const translate = vi.fn().mockResolvedValue('Hello there.');
    const captions = new FaceToFaceCaptions({ first: 'zh', second: 'de' }, translate, { sourceLanguageHints: ['zh', 'de'] });
    captions.opened({ ref: 1, side: 'source', origin: 'h3' });
    captions.text({ ref: 1, text: 'Bonjour, merci beaucoup pour votre aide aujourd’hui.' });
    expect(useFaceToFaceStore.getState().captions[0].sourceLanguage).toBe('fr');
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      'h3', expect.any(AbortSignal), expect.any(Function), true, 'de', expect.objectContaining({ sourceLanguage: 'fr' }),
    );
    captions.opened({ ref: 2, side: 'translation', origin: 'h3' });
    captions.text({ ref: 2, text: '你好。' });
    captions.closed(1);
    captions.closed(2, 'h3');
    await Promise.resolve();

    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      subtitles: { zh: '你好。', de: 'Hello there.' }, final: true,
    });
    expect(useFaceToFaceStore.getState().captions[0]).not.toHaveProperty('speakerNumber');
  });

  it('waits for a genuinely ambiguous source fragment, then routes it as auto', async () => {
    const translate = vi.fn().mockResolvedValue('Guten Tag.');
    const captions = new FaceToFaceCaptions({ first: 'zh', second: 'de' }, translate, { sourceLanguageHints: ['zh', 'en'] });
    captions.opened({ ref: 1, side: 'source', origin: 'ambiguous' });
    captions.text({ ref: 1, text: 'Guten Morgen.' });
    expect(useFaceToFaceStore.getState().captions[0].sourceLanguage).toBeUndefined();
    expect(translate).not.toHaveBeenCalled();
    captions.closed(1);
    await Promise.resolve();
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      'ambiguous', expect.any(AbortSignal), expect.any(Function), false, 'de', expect.objectContaining({ sourceLanguage: undefined }),
    );
  });

  it('uses the shared source-target matcher for locale tags while preserving script distinctions', () => {
    const regional = new FaceToFaceCaptions({ first: 'de', second: 'zh' });
    regional.opened({ ref: 1, side: 'source', origin: 'de-tag' });
    regional.text({ ref: 1, text: 'Der Besprechungsraum ist rechts.', language: 'de-DE' });
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({ sourceLanguage: 'de-DE', subtitles: { de: 'Der Besprechungsraum ist rechts.' } });

    const traditional = new FaceToFaceCaptions({ first: 'zh', second: 'ja' });
    traditional.opened({ ref: 2, side: 'source', origin: 'zh-hant' });
    traditional.text({ ref: 2, text: '這是一個會議。', language: 'zh-Hant' });
    expect(useFaceToFaceStore.getState().captions[1]).toMatchObject({ sourceLanguage: 'zh-Hant', subtitles: {} });
  });

  it('assigns stable first-seen speaker numbers across language changes and late metadata', async () => {
    const translate = vi.fn().mockResolvedValue('translated');
    const captions = new FaceToFaceCaptions({ first: 'ja', second: 'en' }, translate);
    captions.opened({ ref: 1, side: 'source', origin: 'h4' });
    captions.text({ ref: 1, text: 'Good morning.', language: 'en' });
    captions.closed(1);
    captions.text({ ref: 1, text: 'Good morning.', language: 'en', person: 'speaker-7' });

    captions.opened({ ref: 2, side: 'source', origin: 'h5', person: 'speaker-2' });
    captions.text({ ref: 2, text: 'おはようございます。', language: 'ja' });
    captions.closed(2);
    captions.opened({ ref: 3, side: 'source', origin: 'h6', person: 'speaker-7' });
    captions.text({ ref: 3, text: '早上好。', language: 'zh' });
    captions.closed(3);
    await Promise.resolve();

    expect(useFaceToFaceStore.getState().captions.map((row) => row.speakerNumber)).toEqual([1, 2, 1]);
    expect(useFaceToFaceStore.getState().captions.map((row) => row.sourceLanguage)).toEqual(['en', 'ja', 'zh']);
  });

  it('records the replay failure on the same caption', async () => {
    const translate = vi.fn().mockRejectedValue(new Error('Audio range is unavailable.'));
    const captions = new FaceToFaceCaptions({ first: 'ja', second: 'en' }, translate);
    captions.opened({ ref: 1, side: 'source', origin: 'h7' });
    captions.text({ ref: 1, text: 'おはようございます。', language: 'ja' });
    captions.closed(1);
    await Promise.resolve();

    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      subtitles: { ja: 'おはようございます。' }, translationError: 'Audio range is unavailable.',
    });
  });

  it('uses one finalized source for the two additional targets and keeps per-language results', async () => {
    const translate = vi.fn().mockImplementation(async (_id, _signal, _update, _early, language) =>
      language === 'ja' ? 'おはよう' : 'Good morning');
    const captions = new FaceToFaceCaptions({ first: 'zh', second: 'ja', third: 'en' }, translate, { replayFromFinal: true });
    captions.opened({ ref: 1, side: 'source', origin: 'three' });
    captions.text({ ref: 1, text: '早上好', language: 'zh', person: 'one' });
    expect(translate).not.toHaveBeenCalled();
    captions.closed(1);
    await Promise.resolve();
    expect(translate.mock.calls.map((call) => call[4])).toEqual(['ja', 'en']);
    expect(useFaceToFaceStore.getState().captions[0].subtitles).toEqual({ zh: '早上好', ja: 'おはよう', en: 'Good morning' });
  });

  it('ignores speaker IDs on translations and shows conflicting source attribution as unknown', () => {
    const captions = new FaceToFaceCaptions({ first: 'ja', second: 'en' });
    captions.opened({ ref: 1, side: 'source', origin: 'conflict', person: 'a' });
    captions.opened({ ref: 2, side: 'translation', origin: 'conflict', person: 'b' });
    captions.text({ ref: 2, text: 'こんにちは', person: 'b' });
    expect(useFaceToFaceStore.getState().captions[0].speakerNumber).toBe(1);
    captions.text({ ref: 1, text: 'Good morning', language: 'en', person: 'b' });
    expect(useFaceToFaceStore.getState().captions[0].speakerNumber).toBeUndefined();
    captions.opened({ ref: 3, side: 'source', origin: 'same-person', person: 'a' });
    captions.text({ ref: 3, text: 'おはよう', language: 'ja', person: 'a' });
    expect(useFaceToFaceStore.getState().captions[1].speakerNumber).toBe(1);
  });

  it('does not replay the same audio again for an amended transcript', async () => {
    const translate = vi.fn().mockResolvedValue('Hello.');
    const captions = new FaceToFaceCaptions({ first: 'ja', second: 'en' }, translate);
    captions.opened({ ref: 1, side: 'source', origin: 'h8a' });
    captions.text({ ref: 1, text: 'こんにちは。', language: 'ja' });
    captions.closed(1);
    await Promise.resolve();
    expect(useFaceToFaceStore.getState().captions[0].subtitles.en).toBe('Hello.');

    captions.text({ ref: 1, text: 'こんばんは。', language: 'ja' });
    expect(useFaceToFaceStore.getState().captions[0].subtitles).toEqual({ ja: 'こんばんは。', en: 'Hello.' });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('cancels pending audio replay when the run stops', async () => {
    let resolve!: (value: string) => void;
    let signal!: AbortSignal;
    const translate = vi.fn().mockImplementation((_itemId: string, turnSignal: AbortSignal) => {
      signal = turnSignal;
      return new Promise<string>((done) => { resolve = done; });
    });
    const captions = new FaceToFaceCaptions({ first: 'ja', second: 'en' }, translate);
    captions.opened({ ref: 1, side: 'source', origin: 'h9' });
    captions.text({ ref: 1, text: 'おはようございます。', language: 'ja' });
    captions.closed(1);
    captions.stop();
    resolve('Good morning.');
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
    expect(useFaceToFaceStore.getState().captions[0].subtitles).toEqual({ ja: 'おはようございます。' });
  });
});
