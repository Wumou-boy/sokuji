import { multilingualTranscriptLanguage, normalizeTranscriptLanguage } from '../language/meetingTranscript';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { faceToFaceSourceMatchesTarget, faceToFaceTargets, needsTranslation } from './route';
import type { FaceToFaceLanguage, FaceToFaceLanguages } from './route';
import type { FaceToFaceCaption } from '../../stores/faceToFaceStore';

interface Turn {
  id: string;
  source: string;
  sourceLanguage?: string;
  sourceSpeaker?: string;
  speakerNumber?: number;
  localSpeakerNumber?: number;
  speakerUncertain?: boolean;
  startAt?: number;
  endAt?: number;
  timeKind?: 'given' | 'estimated';
  sourceRefs: Set<number>;
  textFinal: boolean;
  translations: Partial<Record<FaceToFaceLanguage, string>>;
  translationErrors: Partial<Record<FaceToFaceLanguage, string>>;
  replays: Map<FaceToFaceLanguage, AbortController>;
}

type RefEntry = { turn: Turn; side: 'source' } | { turn: Turn; side: 'translation'; target: FaceToFaceLanguage };

type ReplayTurn = (itemId: string, signal: AbortSignal, onText: (text: string) => void, early: boolean,
  target: FaceToFaceLanguage, transcript: { source: string; sourceLanguage?: string }) => Promise<string>;

const MAX_TURNS = 128;
const MAX_PENDING_REFS = 256;
const MAX_PENDING_ORIGINS = 128;

/** Joins original text with each selected target and keeps speaker attribution on the source. */
export class FaceToFaceCaptions {
  private readonly turns = new Map<string, Turn>();
  private readonly byRef = new Map<number, RefEntry>();
  private readonly byOrigin = new Map<string, Turn>();
  private readonly pendingByOrigin = new Map<string, number[]>();
  private readonly pendingText = new Map<number, string>();
  private readonly pendingTargets = new Map<number, FaceToFaceLanguage>();
  private readonly speakerNumbers = new Map<string, number>();
  private readonly pendingLocalSpeakers = new Map<string, number>();
  private readonly targets: FaceToFaceLanguage[];
  private useLocalSpeakers: boolean;
  private stopped = false;

  constructor(
    private readonly languages: FaceToFaceLanguages,
    private readonly replayTurn?: ReplayTurn,
    private readonly options: {
      replayFromFinal?: boolean;
      localSpeakers?: boolean;
      sourceLanguageHints?: readonly string[];
      /** Absolute wall-clock cue metadata for a provider source item, when it is available. */
      timingOf?: (origin: string) => { startAt?: number; endAt?: number; timeKind?: 'given' | 'estimated' | 'unknown' };
      /** Wall-clock fallback used at source open/close, never at translation arrival. */
      now?: () => number;
      onCaption?: (caption: FaceToFaceCaption) => void;
    } = {},
  ) {
    this.targets = faceToFaceTargets(languages);
    this.useLocalSpeakers = Boolean(options.localSpeakers);
  }

  opened(e: { ref: number; side: 'source' | 'translation'; origin?: string; person?: string; target?: FaceToFaceLanguage }): void {
    if (this.stopped) return;
    if (e.side === 'source') {
      const id = e.origin ?? `source:${e.ref}`;
      // Providers can repeat an opened event for an origin. Reuse its row and preserve accumulated text.
      let turn = this.turns.get(id) ?? this.byOrigin.get(id);
      if (!turn) {
        turn = {
          id, source: '', textFinal: false, sourceRefs: new Set(),
          translations: {}, translationErrors: {}, replays: new Map(),
          ...(this.options.now ? { startAt: this.options.now(), timeKind: 'estimated' as const } : {}),
        };
        this.turns.set(id, turn);
      }
      turn.sourceRefs.add(e.ref);
      this.byRef.set(e.ref, { turn, side: 'source' });
      if (e.person) this.setSpeaker(turn, e.person);
      if (e.origin) {
        this.byOrigin.set(e.origin, turn);
        turn.localSpeakerNumber ??= this.pendingLocalSpeakers.get(e.origin);
        this.pendingLocalSpeakers.delete(e.origin);
        for (const ref of this.pendingByOrigin.get(e.origin) ?? []) {
          if (!this.byRef.has(ref)) this.attachTranslation(turn, ref);
        }
        this.pendingByOrigin.delete(e.origin);
      }
      this.publish(turn);
      this.pruneTurns();
      return;
    }

    if (e.target) {
      this.pendingTargets.set(e.ref, e.target);
      this.capMap(this.pendingTargets, MAX_PENDING_REFS);
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

  text(e: { ref: number; text: string; language?: string; person?: string; target?: FaceToFaceLanguage }): void {
    if (this.stopped) return;
    const entry = this.byRef.get(e.ref);
    if (!entry) {
      this.pendingText.set(e.ref, e.text);
      this.capMap(this.pendingText, MAX_PENDING_REFS);
      if (e.target) {
        this.pendingTargets.set(e.ref, e.target);
        this.capMap(this.pendingTargets, MAX_PENDING_REFS);
      }
      return;
    }

    const { turn, side } = entry;
    if (side === 'source') {
      if (e.person) this.setSpeaker(turn, e.person);
      turn.source = e.text;
      const language = normalizeTranscriptLanguage(e.language)
        ?? multilingualTranscriptLanguage(e.text, this.options.sourceLanguageHints);
      turn.sourceLanguage = language === 'und' ? undefined : language;
      void this.route(turn);
      return;
    }

    const target = entry.target;
    turn.translations[target] = e.text;
    delete turn.translationErrors[target];
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
      if (turn.endAt === undefined && this.options.now) turn.endAt = this.options.now();
      void this.route(turn);
      return;
    }
    // An earlier translation event can acquire its origin only at close.
    if (!entry) {
      this.attachTranslation(turn, ref);
      this.publish(turn);
    }
  }

  setLocalSpeaker(origin: string, number: number): void {
    if (this.stopped || !this.useLocalSpeakers) return;
    const turn = this.byOrigin.get(origin);
    if (turn) {
      turn.localSpeakerNumber = number;
      this.publish(turn);
    } else {
      this.pendingLocalSpeakers.set(origin, number);
      this.capMap(this.pendingLocalSpeakers, MAX_PENDING_ORIGINS);
    }
  }

  /** Publishes a source turn after out-of-band metadata (such as VAD stop time) changes. */
  refreshTiming(origin: string): void {
    if (this.stopped) return;
    const turn = this.byOrigin.get(origin);
    if (turn?.sourceRefs.size) this.publish(turn);
  }

  fallBackToProviderSpeakers(): void {
    if (this.stopped || !this.useLocalSpeakers) return;
    this.useLocalSpeakers = false;
    this.pendingLocalSpeakers.clear();
    const { captions, upsertCaption } = useFaceToFaceStore.getState();
    for (const caption of captions) {
      const turn = this.turns.get(caption.id);
      if (turn) this.publish(turn);
      else if (caption.speakerNumber !== undefined) upsertCaption({ ...caption, speakerNumber: undefined });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const turn of this.turns.values()) this.cancelReplay(turn);
    this.turns.clear();
    this.byRef.clear();
    this.byOrigin.clear();
    this.pendingByOrigin.clear();
    this.pendingText.clear();
    this.pendingTargets.clear();
    this.speakerNumbers.clear();
    this.pendingLocalSpeakers.clear();
  }

  private setSpeaker(turn: Turn, speakerId: string): void {
    const person = speakerId.trim();
    if (!person || /^(unknown|und|unidentified|-1)$/i.test(person) || turn.speakerUncertain) return;
    if (turn.sourceSpeaker !== undefined && turn.sourceSpeaker !== person) {
      // A single source row can cover overlapping or reassigned speech. Do not
      // attach this uncertainty to later turns with either of the two IDs.
      turn.speakerUncertain = true;
      turn.speakerNumber = undefined;
      return;
    }
    turn.sourceSpeaker = person;
    let number = this.speakerNumbers.get(person);
    if (number === undefined) {
      number = this.speakerNumbers.size + 1;
      this.speakerNumbers.set(person, number);
    }
    turn.speakerNumber = number;
  }

  private publish(turn: Turn): void {
    if (turn.sourceRefs.size > 0 && this.options.timingOf) {
      try {
        const timing = this.options.timingOf(turn.id);
        if (timing.startAt !== undefined && Number.isFinite(timing.startAt)) turn.startAt = timing.startAt;
        if (timing.endAt !== undefined && Number.isFinite(timing.endAt)) turn.endAt = timing.endAt;
        if (timing.timeKind === 'given' || timing.timeKind === 'estimated') turn.timeKind = timing.timeKind;
      } catch { /* Optional timing must not interrupt live captions. */ }
    }
    const error = this.targets.map((language) => turn.translationErrors[language]).find(Boolean);
    const speakerNumber = this.useLocalSpeakers ? turn.localSpeakerNumber : turn.speakerNumber;
    const row: FaceToFaceCaption = {
      id: turn.id,
      source: turn.source,
      ...(turn.sourceLanguage ? { sourceLanguage: turn.sourceLanguage } : {}),
      ...(speakerNumber !== undefined ? { speakerNumber } : {}),
      ...(turn.startAt !== undefined ? { startAt: turn.startAt } : {}),
      ...(turn.endAt !== undefined ? { endAt: turn.endAt } : {}),
      ...(turn.timeKind ? { timeKind: turn.timeKind } : {}),
      subtitles: this.subtitlesFor(turn),
      ...(error ? { translationError: error, translationErrors: { ...turn.translationErrors } } : {}),
      final: turn.textFinal,
    };
    useFaceToFaceStore.getState().upsertCaption(row);
    try { this.options.onCaption?.(row); } catch { /* History must not interrupt live captions. */ }
  }

  private subtitlesFor(turn: Turn): Partial<Record<FaceToFaceLanguage, string>> {
    const sourceTarget = this.targets.find((target) => faceToFaceSourceMatchesTarget(turn.sourceLanguage, target));
    const subtitles: Partial<Record<FaceToFaceLanguage, string>> = {};
    for (const target of this.targets) {
      if (sourceTarget === target && turn.source) subtitles[target] = turn.source;
      else if (turn.translations[target]) subtitles[target] = turn.translations[target];
    }
    return subtitles;
  }

  private route(turn: Turn): void {
    if (this.stopped) return;
    for (const target of this.targets.slice(1)) {
      if (!needsTranslation(turn.sourceLanguage, target)) {
        if (turn.textFinal) turn.replays.get(target)?.abort();
        delete turn.translationErrors[target];
        continue;
      }
      if (!this.replayTurn || !turn.source.trim() || turn.replays.has(target) || turn.translations[target]
        || (!turn.textFinal && (this.options.replayFromFinal || !turn.sourceLanguage))) continue;
      void this.replay(turn, target, this.replayTurn);
    }
    this.publish(turn);
  }

  private async replay(turn: Turn, target: FaceToFaceLanguage, replayTurn: ReplayTurn): Promise<void> {
    const controller = new AbortController();
    turn.replays.set(target, controller);
    delete turn.translationErrors[target];
    try {
      const update = (text: string) => {
        if (this.stopped || controller.signal.aborted || !text || text === turn.translations[target]) return;
        turn.translations[target] = text;
        delete turn.translationErrors[target];
        this.publish(turn);
      };
      update(await replayTurn(turn.id, controller.signal, update, !turn.textFinal, target,
        { source: turn.source, sourceLanguage: turn.sourceLanguage }));
    } catch (error) {
      if (this.stopped || controller.signal.aborted) return;
      if (needsTranslation(turn.sourceLanguage, target)) {
        turn.translationErrors[target] = error instanceof Error ? error.message : 'Subtitle translation failed.';
      }
      this.publish(turn);
    } finally {
      this.pruneTurns();
    }
  }

  private cancelReplay(turn: Turn): void {
    for (const controller of turn.replays.values()) controller.abort();
    turn.replays.clear();
  }

  private attachTranslation(turn: Turn, ref: number): void {
    const target = this.pendingTargets.get(ref) ?? this.languages.first;
    this.pendingTargets.delete(ref);
    this.byRef.set(ref, { turn, side: 'translation', target });
    const pending = this.pendingText.get(ref);
    if (pending !== undefined) {
      turn.translations[target] = pending;
      this.pendingText.delete(ref);
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
