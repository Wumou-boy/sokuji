import { create } from 'zustand';

export type FaceToFacePhase = 'idle' | 'starting' | 'live' | 'stopping' | 'error';
export type AppTranslationMode = 'meeting' | 'face-to-face';
export type FaceToFaceLanguage = 'zh' | 'ja' | 'en';
export interface FaceToFaceLanguages {
  first: FaceToFaceLanguage;
  second: FaceToFaceLanguage;
}

export interface FaceToFaceCaption {
  id: string;
  source: string;
  sourceLanguage?: string;
  speakerNumber?: number;
  subtitles: Partial<Record<FaceToFaceLanguage, string>>;
  translationError?: string;
  final: boolean;
}

interface FaceToFaceState {
  mode: AppTranslationMode;
  phase: FaceToFacePhase;
  error: string | null;
  languages: FaceToFaceLanguages;
  captions: FaceToFaceCaption[];
  setPhase(phase: FaceToFacePhase, error?: string | null): void;
  setMode(mode: AppTranslationMode): void;
  setLanguage(slot: keyof FaceToFaceLanguages, language: FaceToFaceLanguage): void;
  upsertCaption(caption: FaceToFaceCaption): void;
  resetRun(): void;
}

export const useFaceToFaceStore = create<FaceToFaceState>((set) => ({
  mode: 'meeting',
  phase: 'idle',
  error: null,
  languages: { first: 'zh', second: 'ja' },
  captions: [],
  setPhase: (phase, error = null) => set({ phase, error }),
  setMode: (mode) => set({ mode }),
  setLanguage: (slot, language) => set((s) => {
    if ((s.phase !== 'idle' && s.phase !== 'error') || s.languages[slot] === language) return s;
    const other = slot === 'first' ? 'second' : 'first';
    const languages = { ...s.languages, [slot]: language };
    if (s.languages[other] === language) languages[other] = s.languages[slot];
    return { languages, captions: [] };
  }),
  upsertCaption: (caption) => set((s) => {
    const index = s.captions.findIndex((row) => row.id === caption.id);
    if (index < 0) return { captions: [...s.captions, caption].slice(-100) };
    const captions = [...s.captions];
    captions[index] = caption;
    return { captions };
  }),
  resetRun: () => set({ phase: 'idle', error: null, captions: [] }),
}));
