import type { FaceToFaceCaption, FaceToFaceProvider } from '../../stores/faceToFaceStore';
import { historyPort, type HistoryPort } from '../history/port';
import type { HistorySentenceInput } from '../history/types';
import type { HistoryRecorder } from '../history/recording/recorder';
import { languageLabel } from '../language/label';
import { faceToFaceSourceMatchesTarget } from './route';

export type FaceToFaceHistoryStatus = 'saving' | 'saved' | 'partial' | 'disabled';

/** History's sentence has one translation column. Keep every selected subtitle there with its language label. */
export function faceToFaceTranslation(caption: FaceToFaceCaption): string | null {
  const lines = Object.entries(caption.subtitles)
    .filter(([language, text]) => Boolean(text) && !faceToFaceSourceMatchesTarget(caption.sourceLanguage, language))
    .map(([language, text]) => `${languageLabel(language, language)}: ${text}`);
  return lines.length ? lines.join('\n') : null;
}

interface StoredCaption {
  n: number;
  sentence: HistorySentenceInput;
  appended: boolean;
  dirty: boolean;
}

/** Writes the complete face-to-face transcript through the same local History API used by meeting sessions. */
export class FaceToFaceHistory {
  private readonly rows = new Map<string, StoredCaption>();
  private nextNumber = 1;
  private transcriptId: number | null = null;
  private opened = false;
  private closed = false;
  private openRequested = false;
  private hasPartialFailure = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    id: string;
    startedAt: number;
    provider: FaceToFaceProvider;
    firstLanguage: string;
    secondLanguage: string;
    thirdLanguage?: string;
    appVersion: string;
    port?: HistoryPort;
    recorder?: HistoryRecorder;
    onStatus?: (status: FaceToFaceHistoryStatus) => void;
  }) {
    // The microphone starts before the local store has opened the record. Hold its first
    // audio in the same bounded pre-open buffer used by online meeting recordings.
    options.recorder?.prepare(options.id, options.startedAt);
  }

  /** One microphone feed, shared with recognition; the recorder is a passive tap. */
  pcm(pcm: Int16Array): void {
    if (this.closed) return;
    this.options.recorder?.pcm('speaker', pcm);
    if (this.openRequested) return;
    this.openRequested = true;
    this.options.onStatus?.('saving');
    this.enqueue(() => this.ensureRecord());
  }

  caption(caption: FaceToFaceCaption, at: number): void {
    if (this.closed || !caption.source.trim()) return;
    this.openRequested = true;
    let entry = this.rows.get(caption.id);
    if (!entry) {
      const n = this.nextNumber++;
      const startMs = this.relative(caption.startAt, at);
      const endMs = Math.max(startMs, this.relative(caption.endAt, at));
      const created: StoredCaption = {
        n,
        appended: false,
        dirty: true,
        sentence: {
          n,
          segmentId: caption.id,
          side: 'other',
          sideCertain: false,
          track: 'microphone',
          speaker: caption.speakerNumber === undefined ? 'unknown' : String(caption.speakerNumber),
          startMs,
          endMs,
          text: caption.source,
          language: caption.sourceLanguage ?? undefined,
          timeKind: Number.isFinite(caption.startAt) && Number.isFinite(caption.endAt) && caption.timeKind === 'given' ? 'given' : 'estimated',
          translation: faceToFaceTranslation(caption) ?? undefined,
        },
      };
      this.rows.set(caption.id, created);
      entry = created;
    } else {
      const timing = this.revisedTiming(entry.sentence, caption, at);
      entry.sentence = {
        ...entry.sentence,
        ...timing,
        text: caption.source,
        language: caption.sourceLanguage ?? undefined,
        speaker: caption.speakerNumber === undefined ? 'unknown' : String(caption.speakerNumber),
        translation: faceToFaceTranslation(caption) ?? undefined,
      };
      entry.dirty = true;
    }
    this.options.onStatus?.('saving');
    const savedEntry = entry;
    this.enqueue(() => this.flushRows(savedEntry));
  }

  async close(endedAt: number): Promise<{ kept: boolean; complete: boolean; transcriptId: number | null }> {
    this.closed = true;
    if (this.rows.size > 0) this.enqueue(() => this.flushRows());
    await this.queue;
    try { await this.options.recorder?.end(this.options.id); }
    catch { this.hasPartialFailure = true; }
    if (!this.opened) return { kept: false, complete: false, transcriptId: null };
    try {
      const result = await this.withRetry(async () => {
        const current = await this.port().getRecord(this.options.id);
        if (current?.state === 'closed') return { kept: true };
        return this.port().closeRecord({ id: this.options.id, endedAt });
      });
      const complete = result.kept && !this.hasPartialFailure && [...this.rows.values()].every((row) => row.appended && !row.dirty);
      this.options.onStatus?.(complete ? 'saved' : result.kept ? 'partial' : 'disabled');
      return { ...result, complete, transcriptId: this.transcriptId };
    } catch {
      this.options.onStatus?.('partial');
      return { kept: true, complete: false, transcriptId: this.transcriptId };
    }
  }

  private port(): HistoryPort { return this.options.port ?? historyPort(); }

  private relative(cueAt: number | undefined, fallbackAt: number): number {
    return Math.max(0, Math.round((Number.isFinite(cueAt) ? cueAt! : fallbackAt) - this.options.startedAt));
  }

  private revisedTiming(previous: HistorySentenceInput, caption: FaceToFaceCaption, fallbackAt: number): Pick<HistorySentenceInput, 'startMs' | 'endMs' | 'timeKind'> {
    const hasStart = Number.isFinite(caption.startAt);
    const hasEnd = Number.isFinite(caption.endAt);
    const startMs = hasStart ? this.relative(caption.startAt, fallbackAt) : previous.startMs;
    const fallbackEnd = this.relative(fallbackAt, fallbackAt);
    const endMs = hasEnd
      ? Math.max(startMs, this.relative(caption.endAt, fallbackAt))
      : Math.max(startMs, previous.endMs, hasStart ? fallbackEnd : previous.endMs);
    const timeKind = previous.timeKind === 'given' || (hasStart && hasEnd && caption.timeKind === 'given')
      ? 'given'
      : hasStart || hasEnd ? 'estimated' : previous.timeKind;
    return { startMs, endMs, timeKind };
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      try {
        await work();
        this.hasPartialFailure = false;
        if (!this.closed) this.options.onStatus?.('saved');
      } catch (error) {
        this.hasPartialFailure = true;
        this.options.onStatus?.('partial');
      }
    });
  }

  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    let error: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await work(); }
      catch (cause) { error = cause; }
    }
    throw error;
  }

  private async ensureRecord(): Promise<void> {
    const port = this.port();
    if (!this.opened) {
      await this.withRetry(async () => {
        const existing = await port.getRecord(this.options.id);
        if (!existing) {
          await port.openRecord({
            id: this.options.id,
            startedAt: this.options.startedAt,
            mode: 'face-to-face',
            myLanguage: this.options.firstLanguage,
            targetLanguage: this.options.secondLanguage,
            services: { provider: this.options.provider, models: {} },
            appVersion: this.options.appVersion,
          });
        }
        this.options.recorder?.begin(this.options.id, this.options.startedAt);
      });
      this.opened = true;
    }
    await this.withRetry(() => port.putLeg({
      recordId: this.options.id,
      leg: 'speaker',
      languages: { source: 'auto', target: this.options.firstLanguage },
      input: 'microphone', inputName: null, inputId: null, translated: true, spoken: true,
    }));
    await this.withRetry(() => port.putLeg({
      recordId: this.options.id,
      leg: 'participant',
      languages: { source: 'auto', target: this.options.secondLanguage },
      input: 'microphone', inputName: null, inputId: null, translated: true, spoken: false,
    }));
  }

  private async ensureTranscript(): Promise<void> {
    if (this.transcriptId !== null) return;
    const port = this.port();
    await this.withRetry(async () => {
      const record = await port.getRecord(this.options.id);
      const existing = record?.transcripts.find((transcript) => transcript.origin.service === `face-to-face:${this.options.provider}`);
      if (existing) this.transcriptId = existing.id;
      else this.transcriptId = await port.createTranscript({
        recordId: this.options.id,
        origin: { service: `face-to-face:${this.options.provider}`, kind: 'live' },
        textKind: 'original',
      });
    });
  }

  private async flushRows(only?: StoredCaption): Promise<void> {
    await this.ensureRecord();
    await this.ensureTranscript();
    const port = this.port();
    const transcriptId = this.transcriptId;
    if (transcriptId === null) throw new Error('Face-to-face history transcript was not opened.');
    for (const entry of only ? [only] : this.rows.values()) {
      if (!entry.appended) {
        const sentence = entry.sentence;
        await this.withRetry(() => port.appendSentences({ transcriptId, sentences: [sentence] }));
        entry.appended = true;
        if (entry.sentence === sentence) entry.dirty = false;
      } else if (entry.dirty) {
        const sentence = entry.sentence;
        await this.withRetry(() => port.reviseSentences({
          transcriptId,
          revisions: [{
            n: entry.n,
            text: sentence.text,
            translation: sentence.translation ?? null,
            speaker: sentence.speaker,
            language: sentence.language ?? null,
            startMs: sentence.startMs,
            endMs: sentence.endMs,
            timeKind: sentence.timeKind,
          }],
        }));
        if (entry.sentence === sentence) entry.dirty = false;
      }
    }
  }
}
