import { describe, it, expect } from 'vitest';
import i18n from '../../locales';
import { BAILIAN_NOTES, COMPATIBLE_NOTES } from '../../lib/notes/notesService';
import { notesExplanation, NOTES_SERVICE_NAMES } from './notesExplain';

describe('notes privacy explanations for custom services', () => {
  const t = i18n.t.bind(i18n);

  it('names Bailian and says the Qwen key is used for post-session and live notes', () => {
    expect(NOTES_SERVICE_NAMES[BAILIAN_NOTES]).toBe('Qwen / Bailian');
    expect(notesExplanation(t, BAILIAN_NOTES, 'after')).toContain('sent to Qwen / Bailian with your own key');
    expect(notesExplanation(t, BAILIAN_NOTES, 'live')).toContain('sent to Qwen / Bailian with your own key');
  });

  it('names the configured compatible endpoint and explains what it receives for both modes', () => {
    expect(NOTES_SERVICE_NAMES[COMPATIBLE_NOTES]).toBe('your OpenAI-compatible endpoint');
    const explanation = 'The configured endpoint receives transcript text, sentence numbers, speaker labels and word-list spellings. Live updates also include the notes so far.';
    expect(notesExplanation(t, COMPATIBLE_NOTES, 'after')).toBe(explanation);
    expect(notesExplanation(t, COMPATIBLE_NOTES, 'live')).toBe(explanation);
  });
});
