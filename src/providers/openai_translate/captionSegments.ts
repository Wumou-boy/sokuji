import type { AdapterEvents, Side } from '../../lib/contract/adapter';
import type { Clock } from '../../lib/contract/clock';
import { baseLang } from '../../lib/segmentation/sentenceEnd';
import { meetingTranscriptLanguage } from '../../lib/language/meetingTranscript';
import { TranslateSegments } from './segments';
import type { TranslateConfig } from './config';

export type CaptionTranslator = (
  text: string,
  sourceLanguage: string,
  signal: AbortSignal,
) => Promise<string>;

export interface CaptionSegmentsOptions {
  clock: Pick<Clock, 'setTimeout' | 'now'>;
  silence: TranslateConfig['silence'];
  sink: AdapterEvents;
  detectParticipantLanguage: boolean;
  targetLanguage: string;
  translate: CaptionTranslator;
  onFailure?: () => void;
}

interface SourceCaption {
  origin?: string;
  text: string;
  language?: string;
}

interface TranslationJob {
  origin: string;
  text: string;
  sourceLanguage: string;
}

/**
 * Cuts source transcript deltas into stable captions, then translates each
 * closed caption as text. Source events go to the sink immediately; failed or
 * late translation requests never remove or revise them.
 */
export class CaptionSegments {
  private readonly sources = new Map<number, SourceCaption>();
  private readonly queue: TranslationJob[] = [];
  private readonly segments: TranslateSegments;
  private active: AbortController | null = null;
  private nextTranslationRef = -1;
  private running = false;
  private stopped = false;

  constructor(private readonly options: CaptionSegmentsOptions) {
    const sourceSink = {
      segmentOpened: (e: Parameters<AdapterEvents['segmentOpened']>[0]) => {
        this.sources.set(e.ref, { origin: e.origin, text: '' });
        this.options.sink.segmentOpened(e);
      },
      segmentText: (e: Parameters<AdapterEvents['segmentText']>[0]) => {
        const source = this.sources.get(e.ref);
        if (source) {
          source.text = e.text;
          source.language = e.language;
        }
        this.options.sink.segmentText(e);
      },
      segmentClosed: (e: Parameters<AdapterEvents['segmentClosed']>[0]) => {
        const source = this.sources.get(e.ref);
        this.options.sink.segmentClosed(e);
        if (!source) return;
        this.sources.delete(e.ref);
        if (this.stopped) return;
        const text = source.text.trim();
        if (!text) return;

        // Recheck the final text even when source badges are disabled. Short,
        // ambiguous text remains translatable via automatic source detection.
        const detected = source.language && source.language !== 'und'
          ? source.language
          : meetingTranscriptLanguage(text);
        const language = detected === 'und' ? 'auto' : detected;
        if (language !== 'auto' && baseLang(language) === baseLang(this.options.targetLanguage)) return;

        this.queue.push({ origin: source.origin ?? e.origin ?? `s${e.ref}`, text, sourceLanguage: language });
        void this.runNext();
      },
      audio: () => {},
    } satisfies Pick<AdapterEvents, 'segmentOpened' | 'segmentText' | 'segmentClosed' | 'audio'>;

    this.segments = new TranslateSegments({
      clock: options.clock,
      silence: options.silence,
      sink: sourceSink,
      detectParticipantLanguage: options.detectParticipantLanguage,
    });
  }

  input(delta: string): void {
    if (!this.stopped) this.segments.input(delta);
  }

  done(side: Side): void {
    if (!this.stopped) this.segments.done(side);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.active?.abort();
    this.segments.stop();
    this.sources.clear();
  }

  private async runNext(): Promise<void> {
    if (this.stopped || this.running) return;
    const job = this.queue.shift();
    if (!job) return;

    this.running = true;
    const controller = new AbortController();
    this.active = controller;
    try {
      const text = (await this.options.translate(job.text, job.sourceLanguage, controller.signal)).trim();
      if (this.stopped || controller.signal.aborted || !text || text === job.text) return;
      const ref = this.nextTranslationRef--;
      this.options.sink.segmentOpened({ ref, side: 'translation', origin: job.origin });
      this.options.sink.segmentText({ ref, text, language: this.options.targetLanguage });
      this.options.sink.segmentClosed({ ref, origin: job.origin });
    } catch {
      if (!this.stopped && !controller.signal.aborted) this.options.onFailure?.();
    } finally {
      if (this.active === controller) this.active = null;
      this.running = false;
      void this.runNext();
    }
  }
}
