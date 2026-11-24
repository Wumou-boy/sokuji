import { describe, expect, it } from 'vitest';
import { needsTranslation, normalizeFaceToFaceLanguage } from './route';

describe('face-to-face subtitle routing', () => {
  it('normalizes provider locales and recognizes unsupported source languages', () => {
    expect(normalizeFaceToFaceLanguage('ja-JP')).toBe('ja');
    expect(normalizeFaceToFaceLanguage('zh_Hant')).toBe('zh');
    expect(normalizeFaceToFaceLanguage('und')).toBeNull();
    expect(normalizeFaceToFaceLanguage('fr-FR')).toBeNull();
  });

  it('uses original text in the matching selected language', () => {
    expect(needsTranslation('en-US', 'en')).toBe(false);
    expect(needsTranslation('ja-JP', 'ja')).toBe(false);
    expect(needsTranslation('ja-JP', 'zh')).toBe(true);
  });

  it('routes unknown sources through both selected language routes', () => {
    expect(needsTranslation(undefined, 'ja')).toBe(true);
    expect(needsTranslation('fr-FR', 'en')).toBe(true);
    expect(needsTranslation('und', 'en')).toBe(true);
  });
});
