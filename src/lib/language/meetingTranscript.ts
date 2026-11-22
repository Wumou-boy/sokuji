import { detectAll } from 'tinyld';

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
