import type { FaceToFaceLanguage, FaceToFaceLanguages } from '../../stores/faceToFaceStore';
import type { FaceToFaceProvider } from '../../stores/faceToFaceStore';
import { AUTO, canonicalTag, parseCode } from '../language/code';
import { qwenLanguages, QWEN_DEFAULTS } from '../../providers/qwen_livetranslate/settings';
import { translateLanguages, TRANSLATE_DEFAULTS } from '../../providers/openai_translate/settings';
export type { FaceToFaceLanguage, FaceToFaceLanguages } from '../../stores/faceToFaceStore';

const PREFERRED_LANGUAGE_ORDER = ['zh', 'ja', 'en'];
const languageOptionsCache = new Map<string, FaceToFaceLanguage[]>();

/** Exact text-output targets offered by the selected shared translation service. */
export function faceToFaceLanguageOptions(translation: string | null | undefined): readonly FaceToFaceLanguage[] {
  const key = translation ?? '';
  const cached = languageOptionsCache.get(key);
  if (cached) return cached;
  const offered = translation === 'qwen_livetranslate'
    ? qwenLanguages.targets(AUTO, QWEN_DEFAULTS, { speech: false })
    : translation === 'openai_translate'
      ? translateLanguages.targets(AUTO, TRANSLATE_DEFAULTS, { speech: false })
      : [];
  const unique = [...new Set(offered.map(({ value }) => value).filter((value) => parseCode(value)?.kind === 'tag'))];
  const available = new Set(unique);
  const options = [
    ...PREFERRED_LANGUAGE_ORDER.filter((language) => available.has(language)),
    ...unique.filter((language) => !PREFERRED_LANGUAGE_ORDER.includes(language)),
  ];
  languageOptionsCache.set(key, options);
  return options;
}

/** Resolve a saved preference against the selected service without mutating the saved preference. */
export function resolveFaceToFaceLanguages(
  translation: string | null | undefined,
  preference: FaceToFaceLanguages,
): FaceToFaceLanguages | null {
  const options = faceToFaceLanguageOptions(translation);
  if (options.length < 2) return null;
  const available = new Set(options);
  const nextAvailable = (excluded: Set<string>, preferred: readonly (string | undefined)[] = []) =>
    [...preferred, ...PREFERRED_LANGUAGE_ORDER, ...options].find((language) => !!language && available.has(language) && !excluded.has(language));

  // Reserve valid choices in their original slots before filling a missing
  // slot, so a default does not displace another valid saved preference,
  // including an enabled third language.
  let first = available.has(preference.first) ? preference.first : undefined;
  let second = available.has(preference.second) && preference.second !== first ? preference.second : undefined;
  let third = preference.third !== undefined && available.has(preference.third)
    && preference.third !== first && preference.third !== second ? preference.third : undefined;
  if (!first) first = nextAvailable(new Set([second, third].filter((value): value is string => !!value)), [preference.first])!;
  if (!second) second = nextAvailable(new Set([first, third].filter((value): value is string => !!value)), [preference.second])!;

  // A missing third is an intentional user choice and stays off across services.
  if (preference.third !== undefined && !third) third = nextAvailable(new Set([first, second]), [preference.third]);
  return { first, second, ...(third ? { third } : {}) };
}

export function faceToFaceTargetsForService(
  translation: string | null | undefined,
  preference: FaceToFaceLanguages,
): FaceToFaceLanguage[] {
  const resolved = resolveFaceToFaceLanguages(translation, preference);
  return resolved ? faceToFaceTargets(resolved) : [];
}

/** Exact online meeting translation services that Face to Face can run today. */
export function faceToFaceProviderFor(translation: string | null | undefined): FaceToFaceProvider | null {
  if (translation === 'qwen_livetranslate') return 'qwen_livetranslate';
  if (translation === 'openai_translate') return 'openai_translate';
  return null;
}

export function faceToFaceTargets({ first, second, third }: FaceToFaceLanguages): FaceToFaceLanguage[] {
  return [...new Set(third ? [first, second, third] : [first, second])];
}

/** Reduce provider locale tags such as ja-JP and zh-Hant to the supported base language. */
export function normalizeFaceToFaceLanguage(language: string | undefined): FaceToFaceLanguage | null {
  if (!language) return null;
  const tag = language.trim().replace(/_/g, '-');
  try {
    const canonical = canonicalTag(tag);
    return canonical.toLowerCase() !== 'und' && parseCode(canonical)?.kind === 'tag' ? canonical : null;
  } catch { return null; }
}

/** Exact variants match exactly; a region-only source can match a generic target of the same language. */
function normalizedSourceMatchesTarget(source: FaceToFaceLanguage, target: FaceToFaceLanguage): boolean {
  if (source === target) return true;
  const sourceParts = source.split('-');
  const targetParts = target.split('-');
  if (targetParts.length !== 1 || sourceParts[0] !== targetParts[0]) return false;
  // Preserve script/variant distinctions such as zh-Hant and pt-BR. Region-only
  // locales can use their provider's generic target without an extra translation.
  const region = sourceParts[1];
  return sourceParts.length === 2 && !!region && (/^[A-Z]{2}$/.test(region) || /^\d{3}$/.test(region));
}

export function faceToFaceSourceMatchesTarget(sourceLanguage: string | undefined, targetLanguage: FaceToFaceLanguage): boolean {
  const source = normalizeFaceToFaceLanguage(sourceLanguage);
  const target = normalizeFaceToFaceLanguage(targetLanguage);
  return source !== null && target !== null && normalizedSourceMatchesTarget(source, target);
}

/** Find a source's selected output slot after normalizing its BCP-47 tag once. */
export function faceToFaceSourceTarget(sourceLanguage: string | undefined, targets: readonly FaceToFaceLanguage[]): FaceToFaceLanguage | null {
  const source = normalizeFaceToFaceLanguage(sourceLanguage);
  if (!source) return null;
  return targets.find((target) => normalizedSourceMatchesTarget(source, target)) ?? null;
}

/** A same-language caption uses its source text; unknown sources need both selected translations. */
export function needsTranslation(sourceLanguage: string | undefined, targetLanguage: FaceToFaceLanguage): boolean {
  return !faceToFaceSourceMatchesTarget(sourceLanguage, targetLanguage);
}
