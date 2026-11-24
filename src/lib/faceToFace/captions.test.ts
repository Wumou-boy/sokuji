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
    expect(translate).toHaveBeenCalledExactlyOnceWith('h2', expect.any(AbortSignal), expect.any(Function), true);
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

  it('routes both selected languages for an unrecognized original without a speaker ID', async () => {
    const translate = vi.fn().mockResolvedValue('Hello there.');
    const captions = new FaceToFaceCaptions({ first: 'ja', second: 'en' }, translate);
    captions.opened({ ref: 1, side: 'source', origin: 'h3' });
    captions.text({ ref: 1, text: 'Bonjour tout le monde.', language: 'fr-FR' });
    captions.opened({ ref: 2, side: 'translation', origin: 'h3' });
    captions.text({ ref: 2, text: 'こんにちは。', language: 'ja' });
    expect(translate).not.toHaveBeenCalled();
    captions.closed(1);
    captions.closed(2, 'h3');
    await Promise.resolve();

    expect(translate).toHaveBeenCalledExactlyOnceWith('h3', expect.any(AbortSignal), expect.any(Function), false);
    expect(useFaceToFaceStore.getState().captions[0]).toMatchObject({
      subtitles: { ja: 'こんにちは。', en: 'Hello there.' }, final: true,
    });
    expect(useFaceToFaceStore.getState().captions[0]).not.toHaveProperty('speakerNumber');
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
