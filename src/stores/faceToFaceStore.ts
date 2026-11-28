import { create } from 'zustand';
import type { LanguageCode } from '../lib/language/code';
import { canonicalTag, parseCode } from '../lib/language/code';
import { ServiceFactory } from '../services/ServiceFactory';
import { persistSetting } from '../services/persistSetting';

export type FaceToFacePhase = 'idle' | 'starting' | 'live' | 'stopping' | 'error';
export type AppTranslationMode = 'meeting' | 'face-to-face';
export type FaceToFaceLanguage = LanguageCode;
export type FaceToFaceProvider = 'qwen_livetranslate' | 'openai_translate';
export type FaceToFaceLanguageSlot = 'first' | 'second';
export type LocalSpeakerStatus = 'idle' | 'loading' | 'active' | 'unavailable';
export type FaceToFaceHistoryStatus = 'idle' | 'saving' | 'saved' | 'partial' | 'disabled';
export const FACE_TO_FACE_DEFAULT_LANGUAGES = ['zh', 'ja', 'en'] as const;
export interface FaceToFaceLanguages {
  first: FaceToFaceLanguage;
  second: FaceToFaceLanguage;
  third?: FaceToFaceLanguage;
}

export interface FaceToFaceCaption {
  id: string;
  /** Epoch milliseconds on the same clock as the microphone recording. */
  startAt?: number;
  endAt?: number;
  timeKind?: 'given' | 'estimated';
  source: string;
  sourceLanguage?: string;
  speakerNumber?: number;
  subtitles: Partial<Record<FaceToFaceLanguage, string>>;
  translationError?: string;
  translationErrors?: Partial<Record<FaceToFaceLanguage, string>>;
  final: boolean;
}

interface FaceToFaceState {
  mode: AppTranslationMode;
  phase: FaceToFacePhase;
  error: string | null;
  settingsError: boolean;
  languages: FaceToFaceLanguages;
  runLanguages: FaceToFaceLanguages | null;
  localSpeakerStatus: LocalSpeakerStatus;
  historyStatus: FaceToFaceHistoryStatus;
  recordingFailed: boolean;
  captions: FaceToFaceCaption[];
  setPhase(phase: FaceToFacePhase, error?: string | null, settingsError?: boolean): void;
  setMode(mode: AppTranslationMode): void;
  setLanguage(slot: FaceToFaceLanguageSlot, language: FaceToFaceLanguage, current?: FaceToFaceLanguages): void;
  setThirdLanguage(language: FaceToFaceLanguage | null, current?: FaceToFaceLanguages): void;
  setRunLanguages(languages: FaceToFaceLanguages | null): void;
  setLocalSpeakerStatus(status: LocalSpeakerStatus): void;
  setHistoryStatus(status: FaceToFaceHistoryStatus): void;
  upsertCaption(caption: FaceToFaceCaption): void;
  resetRun(): void;
}

const SETTINGS_KEY = 'faceToFace.preferences';
let settingsPromise: Promise<void> | undefined;
let lastWrite: Promise<unknown> = Promise.resolve();
let editCount = 0;

function preferencesChanged(languages: FaceToFaceLanguages) {
  editCount += 1;
  lastWrite = lastWrite.then(() => persistSetting(SETTINGS_KEY, { languages }));
}

function isSupportedLanguage(value: unknown): value is FaceToFaceLanguage {
  return typeof value === 'string' && parseCode(value)?.kind === 'tag';
}

function withThird(first: FaceToFaceLanguage, second: FaceToFaceLanguage, preferredThird?: FaceToFaceLanguage): FaceToFaceLanguages {
  const third = preferredThird && preferredThird !== first && preferredThird !== second
    ? preferredThird
    : preferredThird ? FACE_TO_FACE_DEFAULT_LANGUAGES.find((language) => language !== first && language !== second) : undefined;
  return { first, second, ...(third ? { third } : {}) };
}

function normalizeSavedLanguage(value: unknown): FaceToFaceLanguage | undefined {
  if (!isSupportedLanguage(value)) return undefined;
  try { return canonicalTag(value.replace(/_/g, '-')); } catch { return undefined; }
}

export function ensureFaceToFaceSettings(): Promise<void> {
  if (!settingsPromise) {
    const before = editCount;
    settingsPromise = Promise.resolve().then(async () => {
      const saved = await ServiceFactory.getSettingsService().getSetting<{
        languages?: Partial<Record<keyof FaceToFaceLanguages, unknown>>;
      } | null>(SETTINGS_KEY, null);
      if (!saved || before !== editCount || useFaceToFaceStore.getState().phase !== 'idle') return;
      const first = normalizeSavedLanguage(saved.languages?.first);
      const second = normalizeSavedLanguage(saved.languages?.second);
      const third = normalizeSavedLanguage(saved.languages?.third);
      useFaceToFaceStore.setState({
        ...(first && second && first !== second
          ? { languages: withThird(first, second, third) } : {}),
      });
    }).catch(() => { settingsPromise = undefined; });
  }
  return settingsPromise;
}

export const useFaceToFaceStore = create<FaceToFaceState>((set) => ({
  mode: 'meeting',
  phase: 'idle',
  error: null,
  settingsError: false,
  languages: { first: 'zh', second: 'ja', third: 'en' },
  runLanguages: null,
  localSpeakerStatus: 'idle',
  historyStatus: 'idle',
  recordingFailed: false,
  captions: [],
  setPhase: (phase, error = null, settingsError = false) => set({ phase, error, settingsError }),
  setMode: (mode) => set({ mode }),
  setLanguage: (slot, language, current) => set((s) => {
    const normalized = normalizeSavedLanguage(language);
    if (!normalized || (s.phase !== 'idle' && s.phase !== 'error') || (!current && s.languages[slot] === normalized)) return s;
    const basis = current ?? s.languages;
    const other = slot === 'first' ? 'second' : 'first';
    const languages = { ...basis, [slot]: normalized };
    if (basis[other] === normalized) languages[other] = basis[slot];
    const next = withThird(languages.first, languages.second, languages.third);
    preferencesChanged(next);
    return { languages: next, captions: [] };
  }),
  setThirdLanguage: (language, current) => set((s) => {
    const normalized = language === null ? null : normalizeSavedLanguage(language);
    if ((language !== null && !normalized) || (s.phase !== 'idle' && s.phase !== 'error') || (!current && s.languages.third === normalized)) return s;
    const basis = current ?? s.languages;
    const languages = withThird(basis.first, basis.second, normalized ?? undefined);
    preferencesChanged(languages);
    return { languages, captions: [] };
  }),
  setRunLanguages: (runLanguages) => set({ runLanguages }),
  setLocalSpeakerStatus: (localSpeakerStatus) => set({ localSpeakerStatus }),
  setHistoryStatus: (historyStatus) => set({ historyStatus }),
  upsertCaption: (caption) => set((s) => {
    const index = s.captions.findIndex((row) => row.id === caption.id);
    if (index < 0) return { captions: [...s.captions, caption].slice(-100) };
    const captions = [...s.captions];
    captions[index] = caption;
    return { captions };
  }),
  resetRun: () => set({ phase: 'idle', error: null, settingsError: false, captions: [], localSpeakerStatus: 'idle', historyStatus: 'idle', recordingFailed: false }),
}));
