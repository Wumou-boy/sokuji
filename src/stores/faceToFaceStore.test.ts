import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFaceToFaceSettings, useFaceToFaceStore } from './faceToFaceStore';

const settings = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('../services/ServiceFactory', () => ({ ServiceFactory: {
  getSettingsService: () => ({ getSetting: settings.get, setSetting: settings.set }),
} }));

describe('face-to-face app mode store', () => {
  beforeEach(() => useFaceToFaceStore.setState({
    mode: 'meeting', phase: 'idle', error: null, languages: { first: 'zh', second: 'ja', third: 'en' }, runLanguages: null, localSpeakerStatus: 'idle', captions: [],
  }));

  it('starts a new configuration with Chinese, Japanese, and English subtitles', () => {
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'zh', second: 'ja', third: 'en' });
  });

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
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'ja', second: 'zh', third: 'en' });
    store.setPhase('live');
    store.setLanguage('second', 'en');
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'ja', second: 'zh', third: 'en' });
  });

  it('restores the third language, ignores a legacy provider choice, and persists only subtitle languages', async () => {
    settings.get.mockResolvedValue({ provider: 'openai_translate', languages: { first: 'en', second: 'ja' } });
    await ensureFaceToFaceSettings();
    expect(useFaceToFaceStore.getState()).toMatchObject({ languages: { first: 'en', second: 'ja' } });
    expect(useFaceToFaceStore.getState().languages.third).toBeUndefined();
    useFaceToFaceStore.getState().setThirdLanguage('zh');
    useFaceToFaceStore.getState().setThirdLanguage(null);
    await vi.waitFor(() => expect(settings.set).toHaveBeenCalledWith('faceToFace.preferences', {
      languages: { first: 'en', second: 'ja' },
    }));
  });

  it('keeps the third language unique while live settings are locked', () => {
    const store = useFaceToFaceStore.getState();
    store.setThirdLanguage('en');
    store.setLanguage('first', 'en');
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'en', second: 'ja', third: 'zh' });
    store.setPhase('live');
  });

  it('sets transient local speaker status without changing the persisted preference', () => {
    const persistedWrites = settings.set.mock.calls.length;
    useFaceToFaceStore.getState().setLocalSpeakerStatus('loading');
    expect(useFaceToFaceStore.getState().localSpeakerStatus).toBe('loading');
    expect(settings.set).toHaveBeenCalledTimes(persistedWrites);
  });

  it('sets replay-only language targets without persisting the saved subtitle preference', () => {
    const persistedWrites = settings.set.mock.calls.length;
    useFaceToFaceStore.setState({ languages: { first: 'zh', second: 'ja' } });
    useFaceToFaceStore.getState().setRunLanguages({ first: 'zh', second: 'ja', third: 'en' });
    expect(useFaceToFaceStore.getState()).toMatchObject({
      languages: { first: 'zh', second: 'ja' }, runLanguages: { first: 'zh', second: 'ja', third: 'en' },
    });
    expect(settings.set).toHaveBeenCalledTimes(persistedWrites);
  });

  it('uses the visible service-resolved pair when the user edits after switching providers', () => {
    const beforeWrites = settings.set.mock.calls.length;
    const stored = { first: 'de', second: 'yue', third: 'en' };
    useFaceToFaceStore.setState({ languages: stored });
    const visible = { first: 'de', second: 'zh', third: 'en' };
    expect(useFaceToFaceStore.getState().languages).toEqual(stored);
    expect(settings.set).toHaveBeenCalledTimes(beforeWrites);

    useFaceToFaceStore.getState().setLanguage('first', 'fr', visible);
    expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'fr', second: 'zh', third: 'en' });
  });

  it('stores valid BCP-47 selections with their script and region subtags', () => {
    useFaceToFaceStore.getState().setLanguage('first', 'zh-Hant');
    expect(useFaceToFaceStore.getState().languages.first).toBe('zh-Hant');
  });
});
