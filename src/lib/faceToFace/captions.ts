import { meetingTranscriptLanguage } from '../language/meetingTranscript';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { needsTranslation, normalizeFaceToFaceLanguage } from './route';
import type { FaceToFaceLanguage, FaceToFaceLanguages } from './route';
import type { FaceToFaceCaption } from '../../stores/faceToFaceStore';

interface Turn {
  id: string;
  source: string;
  sourceLanguage?: string;
  speakerNumber?: number;
  sourceRefs: Set<number>;
  qwenText: string;
  textFinal: boolean;
  replayTranslation?: string;
  translationError?: string;
  generation: number;
  replayRequested?: boolean;
  controller?: AbortController;
}

interface RefEntry {
  turn: Turn;
  side: 'source' | 'translation';
}

const MAX_TURNS = 128;
const MAX_PENDING_REFS = 256;
const MAX_PENDING_ORIGINS = 128;

/** Joins Qwen's independent source/translation events and publishes both selected languages. */
export class FaceToFaceCaptions {
  private readonly turns = new Map<string, Turn>();
  private readonly byRef = new Map<number, RefEntry>();
  private readonly byOrigin = new Map<string, Turn>();
  private readonly pendingByOrigin = new Map<string, number[]>();
  private readonly pendingQwenText = new Map<number, string>();
  private readonly speakerNumbers = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly languages: FaceToFaceLanguages,
    private readonly replayTurn: (itemId: string, signal: AbortSignal, onText: (text: string) => void, early: boolean) => Promise<string>,
  ) {}

  opened(e: { ref: number; side: 'source' | 'translation'; origin?: string; person?: string }): void {
    if (this.stopped) return;
    if (e.side === 'source') {
      const id = e.origin ?? `source:${e.ref}`;
      // Providers can repeat an opened event for an origin. Reuse its row and preserve accumulated text.
      let turn = this.turns.get(id) ?? this.byOrigin.get(id);
      if (!turn) {
        turn = {
          id, source: '', qwenText: '', textFinal: false,
          sourceRefs: new Set(), generation: 0,
        };
        this.turns.set(id, turn);
      }
      turn.sourceRefs.add(e.ref);
      this.byRef.set(e.ref, { turn, side: 'source' });
      if (e.person) this.setSpeaker(turn, e.person);
      if (e.origin) {
        this.byOrigin.set(e.origin, turn);
        for (const ref of this.pendingByOrigin.get(e.origin) ?? []) {
          if (!this.byRef.has(ref)) this.attachTranslation(turn, ref);
        }
        this.pendingByOrigin.delete(e.origin);
      }
      this.publish(turn);
      this.pruneTurns();
      return;
    }

    if (e.origin) {
      const turn = this.byOrigin.get(e.origin);
      if (turn) {
        this.attachTranslation(turn, e.ref);
        this.publish(turn);
      } else {
        this.addPendingOrigin(e.origin, e.ref);
      }
    }
  }

  text(e: { ref: number; text: string; language?: string; person?: string }): void {
    if (this.stopped) return;
    const entry = this.byRef.get(e.ref);
    if (!entry) {
      this.pendingQwenText.set(e.ref, e.text);
      this.capMap(this.pendingQwenText, MAX_PENDING_REFS);
      return;
    }

    const { turn, side } = entry;
    if (side === 'source') {
      if (e.person) this.setSpeaker(turn, e.person);
      turn.source = e.text;
      const language = e.language && e.language !== 'und' ? e.language : meetingTranscriptLanguage(e.text);
      turn.sourceLanguage = language === 'und' ? undefined : language;
      void this.route(turn);
      return;
    }

    turn.qwenText = e.text;
    if (e.person) this.setSpeaker(turn, e.person);
    this.publish(turn);
  }

  closed(ref: number, origin?: string): void {
    if (this.stopped) return;
    const entry = this.byRef.get(ref);
    const turn = entry?.turn ?? (origin ? this.byOrigin.get(origin) : undefined);
    if (!turn) {
      if (origin) this.addPendingOrigin(origin, ref);
      return;
    }
    if (entry?.side === 'source' || turn.sourceRefs.has(ref)) {
      turn.textFinal = true;
      void this.route(turn);
      return;
    }
    // An earlier translation event can acquire its origin only at close.
    if (!entry) {
      this.attachTranslation(turn, ref);
      this.publish(turn);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const turn of this.turns.values()) this.cancelReplay(turn);
    this.turns.clear();
    this.byRef.clear();
    this.byOrigin.clear();
    this.pendingByOrigin.clear();
    this.pendingQwenText.clear();
    this.speakerNumbers.clear();
  }

  private setSpeaker(turn: Turn, speakerId: string): void {
    let number = this.speakerNumbers.get(speakerId);
    if (number === undefined) {
      number = this.speakerNumbers.size + 1;
      this.speakerNumbers.set(speakerId, number);
    }
    turn.speakerNumber = number;
  }

  private publish(turn: Turn): void {
    const row: FaceToFaceCaption = {
      id: turn.id,
      source: turn.source,
      ...(turn.sourceLanguage ? { sourceLanguage: turn.sourceLanguage } : {}),
      ...(turn.speakerNumber !== undefined ? { speakerNumber: turn.speakerNumber } : {}),
      subtitles: this.subtitlesFor(turn),
      ...(turn.translationError ? { translationError: turn.translationError } : {}),
      final: turn.textFinal,
    };
    useFaceToFaceStore.getState().upsertCaption(row);
  }

  private subtitlesFor(turn: Turn): Partial<Record<FaceToFaceLanguage, string>> {
    const sourceLanguage = normalizeFaceToFaceLanguage(turn.sourceLanguage);
    const subtitles: Partial<Record<FaceToFaceLanguage, string>> = {};
    for (const target of new Set([this.languages.first, this.languages.second])) {
      if (sourceLanguage === target && turn.source) subtitles[target] = turn.source;
      else if (target === this.languages.first && turn.qwenText) subtitles[target] = turn.qwenText;
      else if (target === this.languages.second && turn.replayTranslation) subtitles[target] = turn.replayTranslation;
    }
    return subtitles;
  }

  private async route(turn: Turn): Promise<void> {
    if (this.stopped) return;
    if (!turn.source.trim() || (!turn.textFinal && !normalizeFaceToFaceLanguage(turn.sourceLanguage))) {
      this.publish(turn);
      return;
    }

    if (!needsTranslation(turn.sourceLanguage, this.languages.second)) {
      if (turn.textFinal && turn.controller) this.cancelReplay(turn);
      turn.translationError = undefined;
      this.publish(turn);
      return;
    }

    // A Qwen item represents one fixed audio range even if its text is revised.
    if (turn.replayRequested) {
      this.publish(turn);
      return;
    }
    const generation = ++turn.generation;
    turn.replayRequested = true;
    turn.translationError = undefined;
    const controller = new AbortController();
    turn.controller = controller;
    this.publish(turn);
    try {
      const update = (text: string) => {
        if (this.stopped || controller.signal.aborted || generation !== turn.generation || text === turn.replayTranslation) return;
        turn.replayTranslation = text;
        turn.translationError = undefined;
        this.publish(turn);
      };
      update(await this.replayTurn(turn.id, controller.signal, update, !turn.textFinal));
    } catch (error) {
      if (this.stopped || controller.signal.aborted || generation !== turn.generation) return;
      if (needsTranslation(turn.sourceLanguage, this.languages.second)) {
        turn.translationError = error instanceof Error ? error.message : 'Subtitle translation failed.';
      }
      this.publish(turn);
    } finally {
      if (generation === turn.generation) turn.controller = undefined;
      this.pruneTurns();
    }
  }

  private cancelReplay(turn: Turn): void {
    turn.controller?.abort();
    turn.controller = undefined;
    turn.generation += 1;
  }

  private attachTranslation(turn: Turn, ref: number): void {
    this.byRef.set(ref, { turn, side: 'translation' });
    const pending = this.pendingQwenText.get(ref);
    if (pending !== undefined) {
      turn.qwenText = pending;
      this.pendingQwenText.delete(ref);
    }
  }

  private addPendingOrigin(origin: string, ref: number): void {
    const refs = this.pendingByOrigin.get(origin) ?? [];
    if (!refs.includes(ref)) refs.push(ref);
    this.pendingByOrigin.set(origin, refs.slice(-8));
    this.capMap(this.pendingByOrigin, MAX_PENDING_ORIGINS);
  }

  private capMap<K, V>(map: Map<K, V>, maximum: number): void {
    while (map.size > maximum) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  private pruneTurns(): void {
    while (this.turns.size > MAX_TURNS) {
      const oldestId = this.turns.keys().next().value as string | undefined;
      if (oldestId === undefined) return;
      const turn = this.turns.get(oldestId);
      if (turn) {
        this.cancelReplay(turn);
        for (const [ref, entry] of this.byRef) if (entry.turn === turn) this.byRef.delete(ref);
        for (const [origin, candidate] of this.byOrigin) if (candidate === turn) this.byOrigin.delete(origin);
        this.turns.delete(oldestId);
      }
    }
  }
}
