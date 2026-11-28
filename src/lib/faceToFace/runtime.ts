import { AdapterStartError, SAMPLE_RATE, type AdapterEvents, type AdapterSession, type SessionContext } from '../contract/adapter';
import { realClock } from '../contract/clock';
import type { SharedSettings } from '../run/types';
import type { OpenSource, Source } from '../session/source';
import { isMissing, readCredentials } from '../provider/credentials';
import { buildQwen } from '../../providers/qwen_livetranslate/config';
import type { QwenSettings } from '../../providers/qwen_livetranslate/settings';
import { qwenLiveTranslateProvider } from '../../providers/qwen_livetranslate/provider';
import { createQwenFaceReplay } from '../../providers/qwen_livetranslate/faceReplay';
import { buildTranslate } from '../../providers/openai_translate/config';
import type { TranslateSettings } from '../../providers/openai_translate/settings';
import { openaiTranslateProvider } from '../../providers/openai_translate/provider';
import { translateCaption } from '../../providers/openai_translate/textTranslation';
import { useSettingsStore } from '../../stores/settingsStore';
import { useProviderStore } from '../../stores/providerStore';
import { useLineUpStore } from '../../stores/lineUpStore';
import { ensureFaceToFaceSettings, useFaceToFaceStore } from '../../stores/faceToFaceStore';
import type { FaceToFaceCaption, FaceToFaceLanguage } from '../../stores/faceToFaceStore';
import { micSettings } from '../audio/appCapture';
import { openMic } from '../audio/capture/mic';
import { LEVEL_STALE_MS, pcm16Peak } from '../audio/levelMeter';
import { FaceToFaceCaptions } from './captions';
import { QwenTurnAudioBuffer, QwenTurnAudioError } from './audioBuffer';
import { faceToFaceLanguageOptions, faceToFaceProviderFor, faceToFaceSourceTarget, faceToFaceTargets, normalizeFaceToFaceLanguage, resolveFaceToFaceLanguages } from './route';
import { isElectron } from '../../utils/environment';
import { beginSessionTokens, finishSessionTokens, linkSessionTokens, unlinkSessionTokens } from '../usage/sessionTokens';
import { getAppVersion } from '../../utils/conversationExport';
import { FaceToFaceHistory } from './history';
import { createHistoryRecorder } from '../history/recording/recorder';
import { webCodecsOpusEncoder } from '../history/recording/opusEncoder';
import { historyPort } from '../history/port';
import { reportError } from '../diagnostics/report';
import { appNotesRunner } from '../notes/appNotes';
import { startLocalDiarization } from './localDiarization';

let activeStop: ((normalEnd?: boolean) => Promise<void>) | null = null;
let activeStarting = false;
let activePreparing: AbortController | null = null;
type StartStage = 'provider' | 'microphone';
interface FixtureSpeakerTurn {
  itemId: string;
  connection: number;
  providerSpeaker?: number | null;
  startMs?: number;
  endMs?: number;
}
interface FaceToFaceDiagnostics {
  stage: StartStage | 'listening';
  input: 'microphone' | 'replay';
  failure: string | null;
  microphoneFrames: number;
  inputSamples: number;
  peak: number;
  replayedCaptions: number;
  replaySamples: number;
  completedReplays: number;
  missingAudioRanges: number;
  lastReplayFailure: string | null;
  lastReplayCloseCode: number | null;
  replayFrames: Record<string, number>;
  targetLanguages: FaceToFaceLanguage[];
  streamProgress: { startedEarly: number; firstTextInputMs: number[] };
  localSpeakerRecognition?: ReturnType<typeof startLocalDiarization>['stats'];
  fixtureSpeakers?: { connections: number; turns: Map<string, FixtureSpeakerTurn> };
}

const REPLAY_FRAMES = new Set([
  'session.created', 'session.updated', 'session.error', 'session.socket_error', 'session.turn_timeout',
  'session.closed', 'session.connection_lost',
  'input_audio_buffer.commit', 'input_audio_buffer.committed', 'response.text.delta', 'response.text.done', 'response.done',
  'conversation.item.input_audio_transcription.completed',
]);

function faceToFaceMicrophoneError(settings = micSettings()): AdapterStartError | null {
  if (!settings.devicesLoaded()) {
    return new AdapterStartError('Audio settings are still loading. Wait for the microphone list to finish loading, then try again.', 'audio_settings_loading');
  }
  if (settings.muted()) {
    return new AdapterStartError('Your microphone is turned off in Settings → Audio. Turn it on to start Face to Face.', 'microphone_muted');
  }
  const deviceId = settings.deviceId();
  if (!deviceId) {
    return new AdapterStartError('No microphone is selected. Select one in Settings → Audio before starting Face to Face.', 'no_microphone_selected');
  }
  if (!settings.isListed(deviceId) || settings.isUnusable(deviceId)) {
    return new AdapterStartError('The selected microphone is unavailable. Choose a connected microphone in Settings → Audio, then try again.', 'microphone_unavailable');
  }
  return null;
}

function replayFailure(error: unknown): string {
  if (error instanceof AdapterStartError && /^[a-z0-9_]{1,40}$/.test(error.code)) return `realtime_start_${error.code}`;
  if (!(error instanceof Error)) return 'realtime_replay_failed';
  if (error.message.includes('response timed out')) return 'realtime_replay_timeout';
  if (error.message.includes('without a translation segment')) return 'realtime_replay_empty';
  if (error.message.includes('multiple translation segments')) return 'realtime_replay_multiple';
  if (error.message.includes('no complete translation text')) return 'realtime_replay_incomplete';
  if (error.message.includes('did not complete')) return 'realtime_response_failed';
  return 'realtime_replay_failed';
}

let diagnostics: FaceToFaceDiagnostics | null = null;
let inputPeak = 0;
let inputPeakAt = -Infinity;

/** Latest microphone or fixture peak, between silence (0) and full scale (1). */
export function readFaceToFaceInputPeak(): number {
  return realClock.now() - inputPeakAt > LEVEL_STALE_MS ? 0 : inputPeak;
}

export function faceToFaceCaptionLanguageSummary(captions: readonly FaceToFaceCaption[], targets: readonly FaceToFaceLanguage[]) {
  const rows = captions.map((row) => {
    const sourceLang = faceToFaceSourceTarget(row.sourceLanguage, targets)
      ?? normalizeFaceToFaceLanguage(row.sourceLanguage);
    const targetLangs = targets.filter((language) => Boolean(row.subtitles[language]?.trim()));
    return {
      speaker: row.speakerNumber ?? null,
      sourceLanguage: row.sourceLanguage ?? null,
      sourceLang,
      targetLangs,
      complete: targets.every((language) => targetLangs.includes(language)),
      final: row.final,
    };
  });
  const sourceCounts: Record<string, number> = {};
  for (const row of rows) {
    const language = row.sourceLang ?? 'unknown';
    sourceCounts[language] = (sourceCounts[language] ?? 0) + 1;
  }
  const targetCounts = Object.fromEntries(targets.map((language) => [
    language,
    rows.filter((row) => row.targetLangs.includes(language)).length,
  ])) as Record<FaceToFaceLanguage, number>;
  return { sourceCounts, targetCounts, rows };
}

function observeFixtureSpeaker(run: NonNullable<FaceToFaceDiagnostics['fixtureSpeakers']>, event: Parameters<AdapterEvents['frame']>[0]) {
  if (event.type !== 'input_audio_buffer.speech_started' && event.type !== 'input_audio_buffer.speech_stopped') return;
  const payload = event.payload as { itemId?: unknown; speaker?: unknown; audioStartMs?: unknown; audioEndMs?: unknown } | undefined;
  if (typeof payload?.itemId !== 'string' || !payload.itemId || payload.itemId.length > 120) return;
  const { itemId } = payload;
  const previous = run.turns.get(itemId);
  if (!previous && run.turns.size >= 180) return;
  const turn = previous ?? { itemId, connection: run.connections };
  if (event.type === 'input_audio_buffer.speech_started') {
    turn.providerSpeaker = typeof payload.speaker === 'number' && Number.isInteger(payload.speaker) ? payload.speaker : null;
    if (typeof payload.audioStartMs === 'number' && Number.isFinite(payload.audioStartMs)) turn.startMs = payload.audioStartMs;
  } else if (typeof payload.audioEndMs === 'number' && Number.isFinite(payload.audioEndMs)) {
    turn.endMs = payload.audioEndMs;
  }
  run.turns.set(itemId, turn);
}

/** Counters for local diagnostics. Audio, captions and server payloads stay private. */
export function getFaceToFaceDiagnostics() {
  if (!diagnostics) return null;
  const { captions } = useFaceToFaceStore.getState();
  const targets = diagnostics.targetLanguages;
  const languageSummary = faceToFaceCaptionLanguageSummary(captions, targets);
  const rows = languageSummary.rows;
  const { rows: replayLanguageRows, ...languageCounts } = languageSummary;
  const { fixtureSpeakers, ...summary } = diagnostics;
  const rowsById = fixtureSpeakers ? new Map(captions.map((row) => [row.id, row])) : undefined;
  return {
    ...summary,
    inputPeak: readFaceToFaceInputPeak(),
    captionCount: captions.length,
    completeCaptionCount: rows.filter((row) => row.complete).length,
    languageSummary: {
      ...languageCounts,
      ...(diagnostics.input === 'replay' ? { rows: replayLanguageRows } : {}),
    },
    speakerNumbers: [...new Set(captions.flatMap((row) => row.speakerNumber === undefined ? [] : [row.speakerNumber]))],
    translationErrorCount: captions.filter((row) => row.translationError).length,
    recentRows: rows.slice(-10),
    ...(fixtureSpeakers ? {
      providerConnections: fixtureSpeakers.connections,
      fixtureSpeakerTurns: [...fixtureSpeakers.turns.values()].map((turn) => {
        const row = rowsById?.get(turn.itemId);
        return { ...turn, appSpeaker: row?.speakerNumber ?? null, hasSource: Boolean(row?.source), final: row?.final ?? false };
      }),
    } : {}),
  };
}

/** Stops the one standalone mic/socket owner; idempotent while it is opening or live. */
export async function stopFaceToFaceRuntime(options: { normalEnd?: boolean } = {}): Promise<void> {
  activePreparing?.abort();
  await activeStop?.(options.normalEnd);
}

export function startFaceToFaceNotesAfterSession(input: {
  recordId: string;
  notesAfterSession: boolean;
  normalEnd: boolean;
  replay: boolean;
  history: { kept: boolean; complete: boolean; transcriptId: number | null };
}): boolean {
  if (!input.notesAfterSession || !input.normalEnd || input.replay || !input.history.kept || !input.history.complete || input.history.transcriptId === null) return false;
  appNotesRunner().start(input.recordId, undefined, input.history.transcriptId);
  return true;
}

export async function startFaceToFaceRuntime(
  signal = new AbortController().signal,
  openSource?: OpenSource,
  options: { replayLocalSpeakers?: boolean; replayThirdLanguage?: FaceToFaceLanguage } = {},
): Promise<(normalEnd?: boolean) => Promise<void>> {
  if (activeStop || activeStarting) throw new Error('Face to Face is already starting or running.');
  activeStarting = true;
  const preparing = new AbortController();
  activePreparing = preparing;
  const abortPreparing = () => preparing.abort();
  let rejectPreparing!: (reason: unknown) => void;
  const preparationCancelled = new Promise<never>((_resolve, reject) => { rejectPreparing = reject; });
  const onPreparationAbort = () => rejectPreparing(new DOMException('Face-to-face session cancelled.', 'AbortError'));
  signal.addEventListener('abort', abortPreparing, { once: true });
  preparing.signal.addEventListener('abort', onPreparationAbort, { once: true });
  if (signal.aborted) abortPreparing();
  try {
    await Promise.race([ensureFaceToFaceSettings(), preparationCancelled]);
    if (signal.aborted || preparing.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
  } catch (error) {
    activeStarting = false;
    activePreparing = null;
    signal.removeEventListener('abort', abortPreparing);
    preparing.signal.removeEventListener('abort', onPreparationAbort);
    throw error;
  }
  preparing.signal.removeEventListener('abort', onPreparationAbort);
  const state = useFaceToFaceStore.getState();
  const translationService = useLineUpStore.getState().lineUp?.translation;
  const providerId = faceToFaceProviderFor(translationService);
  if (!providerId) {
    const lineUpReady = useLineUpStore.getState().lineUp !== null;
    const message = lineUpReady
      ? `Face to Face cannot use the selected translation service${translationService ? ` (${translationService})` : ''}. Choose Qwen LiveTranslate or OpenAI Translate in Languages and line-up settings.`
      : 'The Languages and line-up settings are still loading. Wait for them to finish, then try Face to Face again.';
    activeStarting = false;
    activePreparing = null;
    signal.removeEventListener('abort', abortPreparing);
    state.setRunLanguages(null);
    state.setPhase('error', message, true);
    throw new AdapterStartError(message, lineUpReady ? 'unsupported_translation_service' : 'lineup_pending');
  }
  const sharedMicSettings = openSource ? undefined : micSettings();
  const microphoneError = sharedMicSettings ? faceToFaceMicrophoneError(sharedMicSettings) : null;
  if (microphoneError) {
    activeStarting = false;
    activePreparing = null;
    signal.removeEventListener('abort', abortPreparing);
    state.setRunLanguages(null);
    state.setPhase('error', microphoneError.message, true);
    throw microphoneError;
  }
  const supported = resolveFaceToFaceLanguages(translationService, state.languages);
  const third = openSource ? options.replayThirdLanguage : undefined;
  if (!supported || (third && (third === supported.first || third === supported.second || !faceToFaceLanguageOptions(translationService).includes(third)))) {
    activeStarting = false;
    activePreparing = null;
    signal.removeEventListener('abort', abortPreparing);
    state.setRunLanguages(null);
    const message = 'Choose distinct subtitle languages supported by the selected translation service.';
    state.setPhase('error', message, true);
    throw new Error(message);
  }
  const runLanguages = third ? { ...supported, third } : supported;
  state.setRunLanguages(runLanguages);
  const localSpeakers = providerId === 'qwen_livetranslate'
    && ((openSource && options.replayLocalSpeakers) || useSettingsStore.getState().localSpeakerRecognition);
  const targets = faceToFaceTargets(runLanguages);
  const primaryTarget = runLanguages.first;
  state.resetRun();
  const tokenSession = beginSessionTokens('face-to-face', realClock.now(), isElectron() && !openSource);
  const history = isElectron() && !openSource ? new FaceToFaceHistory({
    id: tokenSession,
    startedAt: realClock.now(),
    provider: providerId,
    firstLanguage: runLanguages.first,
    secondLanguage: runLanguages.second,
    thirdLanguage: runLanguages.third,
    appVersion: getAppVersion() ?? '',
    recorder: createHistoryRecorder({
      port: historyPort(),
      clock: realClock,
      encoder: webCodecsOpusEncoder,
      report: (message, cause) => reportError('History', message, { cause }),
      tell: () => useFaceToFaceStore.setState({ recordingFailed: true }),
    }),
    onStatus: (status) => useFaceToFaceStore.getState().setHistoryStatus(status),
  }) : undefined;
  state.setPhase('starting');
  const run: FaceToFaceDiagnostics = {
    stage: 'provider', input: openSource ? 'replay' : 'microphone', failure: null, microphoneFrames: 0, inputSamples: 0, peak: 0,
    replayedCaptions: 0, replaySamples: 0, completedReplays: 0, missingAudioRanges: 0,
    lastReplayFailure: null, lastReplayCloseCode: null, replayFrames: {},
    targetLanguages: targets,
    streamProgress: { startedEarly: 0, firstTextInputMs: [] },
    ...(openSource && providerId === 'qwen_livetranslate' ? { fixtureSpeakers: { connections: 1, turns: new Map() } } : {}),
  };
  diagnostics = run;
  let session: AdapterSession | undefined;
  let source: Source | undefined;
  let removePcm: (() => void) | undefined;
  let removeEnd: (() => void) | undefined;
  let stopping: Promise<void> | null = null;
  let finishStarting!: () => void;
  const startingSettled = new Promise<void>((resolve) => { finishStarting = resolve; });
  const lifecycle = new AbortController();
  const audioBuffer = new QwenTurnAudioBuffer();
  let localDiarization: ReturnType<typeof startLocalDiarization> | undefined;
  const replays = new Map<FaceToFaceLanguage, ReturnType<typeof createQwenFaceReplay>>();
  let createReplay: ((target: FaceToFaceLanguage) => ReturnType<typeof createQwenFaceReplay>) | undefined;
  let openaiApiKey: string | undefined;
  const router = new FaceToFaceCaptions(runLanguages, async (itemId, turnSignal, onText, early, target, caption) => {
    turnSignal.throwIfAborted();
    run.replayedCaptions += 1;
    if (early) run.streamProgress.startedEarly += 1;
    try {
      if (providerId === 'openai_translate') {
        if (!openaiApiKey || !caption?.source) {
          throw new Error('The finalized source caption is unavailable for translation.');
        }
        const translation = await translateCaption({
          text: caption.source,
          sourceLanguage: caption.sourceLanguage || 'auto',
          targetLanguage: target,
          apiKey: openaiApiKey,
          signal: turnSignal,
        });
        if (translation.trim()) onText(translation);
        run.completedReplays += 1;
        return translation;
      }

      let replay = replays.get(target);
      if (!replay) {
        if (!createReplay) throw new Error('The additional subtitle language is not ready.');
        replay = createReplay(target);
        replays.set(target, replay);
      }
      const frames = async function* () {
        for await (const pcm of audioBuffer.stream(itemId, turnSignal)) {
          run.replaySamples += pcm.length;
          yield pcm;
        }
      };
      let firstText = true;
      const translation = await replay.translateStream(frames(), turnSignal, (text) => {
        if (firstText) {
          firstText = false;
          if (run.streamProgress.firstTextInputMs.length >= 10) run.streamProgress.firstTextInputMs.shift();
          run.streamProgress.firstTextInputMs.push(Math.round(run.inputSamples * 1000 / SAMPLE_RATE));
        }
        onText(text);
      });
      run.completedReplays += 1;
      return translation;
    } catch (error) {
      if (!turnSignal.aborted) {
        if (error instanceof QwenTurnAudioError) run.missingAudioRanges += 1;
        run.lastReplayFailure = error instanceof QwenTurnAudioError ? error.code : replayFailure(error);
      }
      throw error;
    }
  }, {
    replayFromFinal: providerId === 'openai_translate', localSpeakers, sourceLanguageHints: targets,
    now: realClock.now,
    timingOf: providerId === 'qwen_livetranslate' ? (id) => audioBuffer.timeRange(id) : undefined,
    onCaption: (caption) => history?.caption(caption, realClock.now()),
  });

  const dispose = async (normalEnd = false) => {
    if (stopping) return stopping;
    lifecycle.abort();
    inputPeakAt = -Infinity;
    useFaceToFaceStore.getState().setPhase('stopping');
    stopping = (async () => {
      // A stop during socket or mic setup waits for that setup to observe abort and release anything it opened.
      await startingSettled;
      removePcm?.();
      removeEnd?.();
      localDiarization?.dispose();
      router.stop();
      audioBuffer.dispose();
      const closing = session?.stop();
      const releasing = source?.stop();
      await Promise.allSettled([closing, releasing, ...[...replays.values()].map((item) => item.stop())]);
      signal.removeEventListener('abort', abortFromOwner);
      if (history) {
        const result = await history.close(realClock.now());
        if (result.kept) linkSessionTokens('face-to-face', tokenSession, tokenSession);
        else unlinkSessionTokens(tokenSession);
        startFaceToFaceNotesAfterSession({
          recordId: tokenSession,
          notesAfterSession: useSettingsStore.getState().notesAfterSession,
          normalEnd,
          replay: Boolean(openSource),
          history: result,
        });
      }
      finishSessionTokens('face-to-face', tokenSession, realClock.now());
      if (activeStop === dispose) activeStop = null;
      useFaceToFaceStore.getState().setLocalSpeakerStatus('idle');
      useFaceToFaceStore.getState().setPhase('idle');
    })();
    return stopping;
  };

  activeStop = dispose;
  activeStarting = false;
  activePreparing = null;
  signal.removeEventListener('abort', abortPreparing);
  const abortFromOwner = () => { void dispose(); };
  signal.addEventListener('abort', abortFromOwner, { once: true });
  if (signal.aborted) abortFromOwner();

  try {
    const open = async () => {
      const provider = providerId === 'qwen_livetranslate' ? qwenLiveTranslateProvider : openaiTranslateProvider;
      if (!useProviderStore.getState().entries[providerId]) await useProviderStore.getState().load(provider);
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      const entry = useProviderStore.getState().entries[providerId];
      if (!entry) throw new Error(`${providerId === 'qwen_livetranslate' ? 'Qwen LiveTranslate' : 'OpenAI Translate'} settings are not loaded. Open Settings and configure the provider first.`);
      const settings = entry.settings as QwenSettings | TranslateSettings;
      const credentials = readCredentials(provider, settings, entry.credentials, { signedIn: false, getToken: async () => null });
      if (isMissing(credentials)) throw new AdapterStartError(credentials.missing, 'credentials_missing');
      const supportedTargets = (providerId === 'qwen_livetranslate'
        ? qwenLiveTranslateProvider.languages.targets('auto', settings as QwenSettings, { speech: false })
        : openaiTranslateProvider.languages.targets('auto', settings as TranslateSettings, { speech: false }))
        .map((language) => language.value);
      const unsupportedTargets = targets.filter((target) => !supportedTargets.includes(target));
      if (unsupportedTargets.length) {
        throw new Error(`${providerId === 'qwen_livetranslate' ? 'Qwen LiveTranslate' : 'OpenAI Translate'} does not support the selected subtitle language${unsupportedTargets.length === 1 ? '' : 's'}: ${unsupportedTargets.join(', ')}.`);
      }

      const shared: SharedSettings = {
        pauses: {
          sourceSeconds: useSettingsStore.getState().segmentationSourcePause,
          translationSeconds: useSettingsStore.getState().segmentationTranslationPause,
        },
        segmentation: {
          mode: useSettingsStore.getState().segmentationMode,
          sentencesPerRow: useSettingsStore.getState().sentenceSegmentationChunkSentences,
        },
        reversed: () => true,
        models: [],
      };
      const translationRefs = new Set<number>();
      const events: AdapterEvents = {
        segmentOpened: (e) => {
          if (e.side === 'translation') translationRefs.add(e.ref);
          router.opened(e.side === 'translation' ? { ...e, target: primaryTarget } : e);
        },
        segmentText: (e) => router.text(translationRefs.has(e.ref) ? { ...e, target: primaryTarget } : e),
        segmentClosed: (e) => {
          router.closed(e.ref, e.origin);
          translationRefs.delete(e.ref);
        },
        audio: () => {},
        speechRanges: () => {},
        closed: () => {},
        reconnecting: () => {},
        reconnected: () => { if (run.fixtureSpeakers) run.fixtureSpeakers.connections += 1; },
        failed: (e) => {
          run.failure = 'provider_failed';
          void dispose().then(() => useFaceToFaceStore.getState().setPhase('error', e.message));
        },
        degraded: () => {},
        loading: () => {},
        busy: () => {},
        frame: (event) => {
          if (run.fixtureSpeakers) observeFixtureSpeaker(run.fixtureSpeakers, event);
          if (event.type === 'input_audio_buffer.speech_stopped') {
            const { itemId } = (event.payload ?? {}) as { itemId?: unknown };
            if (typeof itemId === 'string' && itemId) {
              router.refreshTiming(itemId);
              localDiarization?.speechStopped(itemId);
            }
          }
        },
      };
      if (providerId === 'qwen_livetranslate') {
        const qwenSettings = settings as QwenSettings;
        const context: SessionContext = { direction: { source: 'auto', target: primaryTarget }, speech: false, turns: 'auto' };
        const config = buildQwen(context, qwenSettings, shared);
        if ('refused' in config) throw new Error(config.refused);
        config.activity = 'face-to-face';
        // Face To Face always needs diarization, regardless of the meeting-only speaker-label preference.
        config.person = true;
        config.detectIncomingLanguage = true;
        config.sourceLanguageHints = targets;
        config.skipSameLanguageText = false;
        config.turnAudio = audioBuffer;
        if (localSpeakers) {
          localDiarization = startLocalDiarization(audioBuffer, lifecycle.signal, (status) => {
            useFaceToFaceStore.getState().setLocalSpeakerStatus(status);
            if (status === 'unavailable') router.fallBackToProviderSpeakers();
          }, (itemId, number) => router.setLocalSpeaker(itemId, number));
          run.localSpeakerRecognition = localDiarization.stats;
        }

        const unit = qwenLiveTranslateProvider.units[0];
        if (!unit.start) throw new Error('This Qwen unit cannot start a realtime audio session.');
        const startSession = unit.start;
        const replayContext: SessionContext = { direction: { source: 'auto', target: runLanguages.second }, speech: false, turns: 'manual' };
        const replayConfig = buildQwen(replayContext, qwenSettings, shared);
        if ('refused' in replayConfig) throw new Error(replayConfig.refused);
        replayConfig.activity = 'face-to-face';
        replayConfig.person = false;
        replayConfig.detectIncomingLanguage = false;
        replayConfig.skipSameLanguageText = false;
        createReplay = (target) => createQwenFaceReplay({
          signal: lifecycle.signal,
          targetLanguage: target,
          start: (events, signal, targetLanguage) => {
            const targetContext = targetLanguage ? { ...replayContext, direction: { ...replayContext.direction, target: targetLanguage } } : replayContext;
            const targetConfig = targetLanguage ? buildQwen(targetContext, qwenSettings, shared) : replayConfig;
            if ('refused' in targetConfig) throw new Error(targetConfig.refused);
            targetConfig.activity = 'face-to-face';
            targetConfig.person = false;
            targetConfig.detectIncomingLanguage = false;
            targetConfig.skipSameLanguageText = false;
            return startSession({ context: targetContext, config: targetConfig, credentials, clock: realClock, signal }, {
              ...events,
              frame: (event) => {
                if (REPLAY_FRAMES.has(event.type)) run.replayFrames[event.type] = (run.replayFrames[event.type] ?? 0) + 1;
                if (event.type === 'session.closed' || event.type === 'session.connection_lost') {
                  const code = (event.payload as { code?: unknown } | undefined)?.code;
                  if (typeof code === 'number' && Number.isInteger(code)) run.lastReplayCloseCode = code;
                }
                events.frame(event);
              },
            });
          },
        });
        const micError = sharedMicSettings ? faceToFaceMicrophoneError(sharedMicSettings) : null;
        if (micError) throw micError;
        session = await startSession({ context, config, credentials, clock: realClock, signal: lifecycle.signal }, events);
      } else {
        const translateSettings = settings as TranslateSettings;
        const context: SessionContext = { direction: { source: primaryTarget, target: primaryTarget }, speech: false, turns: 'auto' };
        const config = buildTranslate(context, translateSettings, shared);
        if ('refused' in config) throw new Error(config.refused);
        // OpenAI Translate can detect the source speech while emitting one native target transcript.
        config.detectParticipantLanguage = true;
        config.sourceLanguageHints = targets;
        openaiApiKey = credentials.apiKey;
        const unit = openaiTranslateProvider.units[0];
        if (!unit.start) throw new Error('OpenAI Translate cannot start a realtime audio session.');
        const micError = sharedMicSettings ? faceToFaceMicrophoneError(sharedMicSettings) : null;
        if (micError) throw micError;
        session = await unit.start({ context, config, credentials, clock: realClock, signal: lifecycle.signal }, events);
      }
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      run.stage = 'microphone';
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      source = openSource
        ? await openSource('speaker', lifecycle.signal)
        : await openMic(sharedMicSettings!, lifecycle.signal);
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      removePcm = source.onPcm((pcm) => {
        if (lifecycle.signal.aborted) return;
        run.microphoneFrames += 1;
        run.inputSamples += pcm.length;
        const chunkPeak = pcm16Peak(pcm);
        run.peak = Math.max(run.peak, chunkPeak);
        inputPeak = chunkPeak / 32768;
        inputPeakAt = realClock.now();
        history?.pcm(pcm);
        session?.appendAudio(pcm);
      });
      removeEnd = source.onEnded((message) => {
        run.failure = 'microphone_ended';
        const error = message || 'The microphone stopped.';
        void dispose().then(() => useFaceToFaceStore.getState().setPhase('error', error));
      });
      run.stage = 'listening';
      useFaceToFaceStore.getState().setPhase('live');
    };
    const opening = open();
    try {
      await opening;
    } finally {
      finishStarting();
    }
    return dispose;
  } catch (error) {
    const cancelled = lifecycle.signal.aborted || signal.aborted || (error instanceof Error && error.name === 'AbortError');
    if (!cancelled) {
      const code = error instanceof AdapterStartError && /^[a-z0-9_]{1,40}$/.test(error.code) ? `_${error.code}` : '';
      run.failure = `${run.stage}_start_failed${code}`;
    }
    // Resolve the stop gate even when setup fails before it yields a session.
    finishStarting();
    await dispose();
    if (!cancelled) useFaceToFaceStore.getState().setPhase('error', error instanceof Error ? error.message : 'Could not start face-to-face translation.');
    throw error;
  }
}
