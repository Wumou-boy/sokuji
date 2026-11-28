import { describe, expect, it } from 'vitest';
import { meetingTranscriptLanguage, multilingualTranscriptLanguage, normalizeTranscriptLanguage } from './meetingTranscript';

describe('multilingual transcript language', () => {
  it('keeps the existing meeting language detector path intact for online captions', () => {
    expect(meetingTranscriptLanguage('The meeting begins at three.')).toBe('en');
  });

  it.each([
    ['German', 'Der Besprechungsraum ist rechts.', 'de'],
    ['Spanish', 'Hola, el proyecto empieza ahora.', 'es'],
    ['French', 'Bonjour, merci beaucoup pour votre aide aujourd’hui.', 'fr'],
    ['Russian', 'Привет, как ваши дела сегодня?', 'ru'],
    ['Chinese', '我们开始会议并讨论测试结果。', 'zh'],
    ['Japanese', '今日は会議の資料を確認します。', 'ja'],
  ])('detects %s locally across the full supported language set', (_label, text, language) => {
    expect(multilingualTranscriptLanguage(text)).toBe(language);
  });

  it('uses a selected source-language hint only to break a close local tie', () => {
    expect(multilingualTranscriptLanguage('Guten Morgen.', ['de', 'en'])).toBe('de');
    expect(multilingualTranscriptLanguage('Guten Morgen.', ['en', 'ja', 'zh'])).toBe('und');
    expect(multilingualTranscriptLanguage('Der Besprechungsraum ist rechts.', ['en', 'zh'])).toBe('de');
  });

  it('leaves short or weakly separated Latin candidates unknown instead of guessing English', () => {
    expect(multilingualTranscriptLanguage('Meeting starts at two.', ['en'])).toBe('und');
    expect(multilingualTranscriptLanguage('I can.', ['en'])).toBe('und');
    expect(multilingualTranscriptLanguage('Merci.')).toBe('und');
    expect(multilingualTranscriptLanguage('会议')).toBe('und');
  });

  it('canonicalizes trustworthy provider source-language tags and rejects unknown sentinels', () => {
    expect(normalizeTranscriptLanguage('de-DE')).toBe('de-DE');
    expect(normalizeTranscriptLanguage('zh_Hant_TW')).toBe('zh-Hant-TW');
    expect(normalizeTranscriptLanguage('und')).toBeUndefined();
    expect(normalizeTranscriptLanguage('automatic')).toBeUndefined();
  });
});
