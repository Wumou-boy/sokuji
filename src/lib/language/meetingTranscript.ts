import { detectAll } from 'tinyld';
import { canonicalTag } from './code';

const MEETING_LANGUAGES = ['en', 'ja', 'zh'] as const;
export type MeetingLanguage = typeof MEETING_LANGUAGES[number];
const DETECT_OPTIONS = { only: [...MEETING_LANGUAGES] };

export function isMeetingLanguage(code: string): code is MeetingLanguage {
  return MEETING_LANGUAGES.some((language) => language === code);
}

const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN_WORD = /\p{Script=Latin}{2,}/gu;

/** A source-caption hint only. A transcript may be ambiguous even when the audio was understood. */
export function meetingTranscriptLanguage(text: string): MeetingLanguage | 'und' {
  const normalized = text.normalize('NFKC')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[A-Z][A-Z\d_-]+\b/g, ' ')
    .trim();
  const han = normalized.match(HAN)?.length ?? 0;
  const kana = KANA.test(normalized);
  const latin = normalized.match(LATIN_WORD) ?? [];

  // Short Han-only phrases can read the same in Chinese and Japanese.
  if (!kana && han > 0 && han < 4) return 'und';
  if (!kana && han === 0 && latin.length < 2 && (latin[0]?.length ?? 0) < 5) return 'und';
  // A run with enough Latin words and East Asian script may contain a second clause.
  // Keep technical names and short borrowed phrases in the source language.
  if ((kana || han > 0) && latin.length >= 4) return 'und';

  const [best, next] = detectAll(normalized, DETECT_OPTIONS);
  if (!best || !isMeetingLanguage(best.lang) || (next && next.accuracy >= best.accuracy * 0.8)) return 'und';
  if (han > 0 && !kana && best.accuracy < 0.2) return 'und';
  if (best.lang === 'en' && (han || kana)) return 'und';
  if (best.lang !== 'en' && !han && !kana) return 'und';
  return best.lang;
}

/**
 * Canonicalizes a provider's source-language tag. The source caption is not
 * constrained to the three languages supported by the legacy meeting badge.
 */
export function normalizeTranscriptLanguage(language: string | null | undefined): string | undefined {
  if (!language || language.length > 64) return undefined;
  const tag = language.trim().replace(/_/g, '-');
  if (!tag || /^(?:und|auto)$/i.test(tag)) return undefined;
  try { return canonicalTag(tag); } catch { return undefined; }
}

/**
 * Local multilingual source-language estimate for captions. `tinyld` runs
 * synchronously in process (the normal build covers 62 languages); there is
 * no service call. Hints can break a close local tie, but cannot overrule a
 * clear result in another language. Short or close candidates stay unknown.
 */
export function multilingualTranscriptLanguage(text: string, hints: readonly string[] = []): string | 'und' {
  const normalized = text.normalize('NFKC')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[A-Z][A-Z\d_-]+\b/g, ' ')
    .trim();
  if (!normalized) return 'und';

  const han = normalized.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
  const latinWords = normalized.match(/\p{Script=Latin}+/gu) ?? [];
  const letters = normalized.match(/[\p{L}\p{M}]/gu)?.length ?? 0;
  const hintSet = new Set(hints.map(normalizeTranscriptLanguage)
    .filter((value): value is string => Boolean(value))
    .map((value) => value.split('-')[0].toLowerCase()));

  // Kana is decisive Japanese evidence; short Han-only phrases can be read
  // identically in Chinese and Japanese, so do not invent a source label.
  if (kana && han === 0) return 'ja';
  if (han > 0 && !kana && han < 4) return 'und';
  // Avoid treating an isolated acronym/name as an English transcript.
  if (han === 0 && !kana && letters < 8) return 'und';
  // A transcript mixing several clauses in different scripts is ambiguous.
  if ((han > 0 || kana) && latinWords.length >= 4) return 'und';

  const ranked = detectAll(normalized);
  const top = ranked[0];
  if (!top) return 'und';

  let candidate = top;
  // Selected languages are only a small prior: prefer one only among nearly
  // tied local candidates, never when the text clearly supports another.
  const nearTopHint = ranked.find((row) => hintSet.has(row.lang) && row.accuracy >= top.accuracy * 0.85);
  const scores = new Map(ranked.map((row) => [row.lang, row.accuracy]));
  if (nearTopHint) {
    scores.set(nearTopHint.lang, nearTopHint.accuracy * 1.15);
  }
  candidate = ranked.reduce((best, row) => (scores.get(row.lang)! > scores.get(best.lang)! ? row : best), top);
  const secondScore = Math.max(0, ...ranked.filter((row) => row.lang !== candidate.lang).map((row) => scores.get(row.lang) ?? 0));
  const confidence = scores.get(candidate.lang) ?? 0;
  const margin = confidence - secondScore;
  if (confidence < 0.06 || margin < Math.max(0.015, confidence * 0.2)) return 'und';
  return candidate.lang;
}
