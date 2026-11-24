import type { FaceToFaceLanguage } from '../../stores/faceToFaceStore';
export type { FaceToFaceLanguage, FaceToFaceLanguages } from '../../stores/faceToFaceStore';

/** Reduce provider locale tags such as ja-JP and zh-Hant to the supported base language. */
export function normalizeFaceToFaceLanguage(language: string | undefined): FaceToFaceLanguage | null {
  if (!language) return null;
  const base = language.trim().split(/[-_]/, 1)[0]?.toLowerCase();
  return base === 'zh' || base === 'ja' || base === 'en' ? base : null;
}

/** A same-language caption uses its source text; unknown sources need both selected translations. */
export function needsTranslation(sourceLanguage: string | undefined, targetLanguage: FaceToFaceLanguage): boolean {
  const source = normalizeFaceToFaceLanguage(sourceLanguage);
  return source === null || source !== targetLanguage;
}
