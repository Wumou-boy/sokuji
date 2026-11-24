import { beforeEach, describe, expect, it } from 'vitest';
import { useFaceToFaceStore } from './faceToFaceStore';

describe('face-to-face app mode store', () => {
  beforeEach(() => useFaceToFaceStore.setState({
    mode: 'meeting', phase: 'idle', error: null, languages: { first: 'zh', second: 'ja' }, captions: [],
  }));

  it('keeps the selected mode explicit and preserves transcript order as rows update', () => {
    const store = useFaceToFaceStore.getState();
    store.setMode('face-to-face');
    store.upsertCaption({ id: 'h1', source: 'First', subtitles: {}, final: false });
    store.upsertCaption({ id: 'h2', source: 'Second', subtitles: {}, final: true });
    store.upsertCaption({ id: 'h1', source: 'First, finalized.', subtitles: {}, final: true });
    expect(useFaceToFaceStore.getState().mode).toBe('face-to-face');
    expect(useFaceToFaceStore.getState().captions.map((row) => row.id)).toEqual(['h1', 'h2']);
    expect(useFaceToFaceStore.getState().captions[0].source).toBe('First, finalized.');
  });

  it('keeps the two languages distinct and locks the pair during listening', () => {
    const store = useFaceToFaceStore.getState();
    store.setLanguage('first', 'ja');
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'ja', second: 'zh' });
    store.setPhase('live');
    store.setLanguage('second', 'en');
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'ja', second: 'zh' });
  });
});
