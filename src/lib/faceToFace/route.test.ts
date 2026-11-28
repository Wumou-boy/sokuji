import { describe, expect, it } from 'vitest';
import { faceToFaceLanguageOptions, faceToFaceProviderFor, faceToFaceSourceMatchesTarget, faceToFaceTargetsForService, needsTranslation, normalizeFaceToFaceLanguage, resolveFaceToFaceLanguages } from './route';

describe('face-to-face subtitle routing', () => {
  it('maps only the exact translation providers supported by the standalone runtime', () => {
    expect(faceToFaceProviderFor('qwen_livetranslate')).toBe('qwen_livetranslate');
    expect(faceToFaceProviderFor('openai_translate')).toBe('openai_translate');
    for (const unsupported of [undefined, null, 'kizunaai_qwen', 'openai', 'openai_live', 'openai_text', 'soniox', 'bing', 'local_inference']) {
      expect(faceToFaceProviderFor(unsupported)).toBeNull();
    }
  });

  it('canonicalizes any valid BCP-47 source language without dropping scripts or variants', () => {
    expect(normalizeFaceToFaceLanguage('ja-JP')).toBe('ja-JP');
    expect(normalizeFaceToFaceLanguage('zh_Hant')).toBe('zh-Hant');
    expect(normalizeFaceToFaceLanguage('pt-br')).toBe('pt-BR');
    expect(normalizeFaceToFaceLanguage('yue')).toBe('yue');
    expect(normalizeFaceToFaceLanguage('und')).toBeNull();
    expect(normalizeFaceToFaceLanguage('not a language')).toBeNull();
  });

  it('uses original text in the matching selected language', () => {
    expect(needsTranslation('en-US', 'en')).toBe(false);
    expect(needsTranslation('ja-JP', 'ja')).toBe(false);
    expect(needsTranslation('ja-JP', 'zh')).toBe(true);
  });

  it('routes unknown sources through both selected language routes', () => {
    expect(needsTranslation(undefined, 'ja')).toBe(true);
    expect(needsTranslation('und', 'en')).toBe(true);
  });

  it('matches exact wire tags and generic targets for region-only source locales but preserves scripts and variants', () => {
    expect(faceToFaceSourceMatchesTarget('de-DE', 'de')).toBe(true);
    expect(faceToFaceSourceMatchesTarget('ja-JP', 'ja')).toBe(true);
    expect(faceToFaceSourceMatchesTarget('en-US', 'en')).toBe(true);
    expect(faceToFaceSourceMatchesTarget('fr-FR', 'fr')).toBe(true);
    expect(faceToFaceSourceMatchesTarget('es-MX', 'es')).toBe(true);
    expect(faceToFaceSourceMatchesTarget('pt-BR', 'pt')).toBe(true);
    expect(faceToFaceSourceMatchesTarget('zh-Hant', 'zh')).toBe(false);
    expect(faceToFaceSourceMatchesTarget('pt-BR', 'pt-PT')).toBe(false);
    expect(faceToFaceSourceMatchesTarget('yue', 'zh')).toBe(false);
    expect(faceToFaceSourceMatchesTarget('zh-Hant', 'zh-Hant')).toBe(true);
  });

  it('uses each shared translation service text-target wire list', () => {
    const qwen = faceToFaceLanguageOptions('qwen_livetranslate');
    const openai = faceToFaceLanguageOptions('openai_translate');
    expect(qwen).toHaveLength(60);
    expect(qwen.slice(0, 3)).toEqual(['zh', 'ja', 'en']);
    expect(qwen).toContain('yue');
    expect(qwen).not.toContain('zh-Hant');
    expect(openai).toContain('zh');
    expect(openai).toContain('ja');
    expect(openai).toContain('en');
    expect(faceToFaceLanguageOptions('soniox')).toEqual([]);
  });

  it('resolves preferences uniquely, preserves an intentional third-off setting, and picks a replacement only for enabled third', () => {
    expect(resolveFaceToFaceLanguages('qwen_livetranslate', { first: 'en', second: 'ja' }))
      .toEqual({ first: 'en', second: 'ja' });
    expect(resolveFaceToFaceLanguages('openai_translate', { first: 'not-a-tag', second: 'ja', third: 'ja' }))
      .toEqual({ first: 'zh', second: 'ja', third: 'en' });
    expect(resolveFaceToFaceLanguages('openai_translate', { first: 'uk', second: 'zh', third: 'de' }))
      .toEqual({ first: 'ja', second: 'zh', third: 'de' });
    expect(resolveFaceToFaceLanguages('openai_translate', { first: 'uk', second: 'fr', third: 'zh' }))
      .toEqual({ first: 'ja', second: 'fr', third: 'zh' });
    expect(faceToFaceTargetsForService('qwen_livetranslate', { first: 'zh-Hant', second: 'ja', third: 'en' }))
      .toEqual(['zh', 'ja', 'en']);
  });
});
