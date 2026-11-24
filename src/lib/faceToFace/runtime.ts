import { AdapterStartError, SAMPLE_RATE, type AdapterEvents, type AdapterSession, type SessionContext } from '../contract/adapter';
import { realClock } from '../contract/clock';
import type { SharedSettings } from '../run/types';
import type { OpenSource, Source } from '../session/source';
import { isMissing, readCredentials } from '../provider/credentials';
import { buildQwen } from '../../providers/qwen_livetranslate/config';
import type { QwenSettings } from '../../providers/qwen_livetranslate/settings';
import { qwenLiveTranslateProvider } from '../../providers/qwen_livetranslate/provider';
import { createQwenFaceReplay } from '../../providers/qwen_livetranslate/faceReplay';
import { useProviderStore } from '../../stores/providerStore';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { getAppSession } from '../../app/session';
import { FaceToFaceCaptions } from './captions';
import { QwenTurnAudioBuffer, QwenTurnAudioError } from './audioBuffer';
import { isElectron } from '../../utils/environment';
import { beginSessionTokens, finishSessionTokens } from '../usage/sessionTokens';

let activeStop: (() => Promise<void>) | null = null;
type StartStage = 'provider' | 'microphone';
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
  streamProgress: { startedEarly: number; firstTextInputMs: number[] };
}

const REPLAY_FRAMES = new Set([
  'session.created', 'session.updated', 'session.error', 'session.socket_error', 'session.turn_timeout',
  'session.closed', 'session.connection_lost',
  'input_audio_buffer.commit', 'input_audio_buffer.committed', 'response.text.delta', 'response.text.done', 'response.done',
  'conversation.item.input_audio_transcription.completed',
]);

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

/** Counters for local diagnostics. Audio, captions and server payloads stay private. */
export function getFaceToFaceDiagnostics() {
  if (!diagnostics) return null;
  const { captions, languages } = useFaceToFaceStore.getState();
  const rows = captions.map((row) => ({
    speaker: row.speakerNumber ?? null,
    sourceLanguage: row.sourceLanguage ?? null,
    bilingual: Boolean(row.subtitles[languages.first] && row.subtitles[languages.second]),
    final: row.final,
  }));
  return {
    ...diagnostics,
    captionCount: captions.length,
    bilingualCaptionCount: rows.filter((row) => row.bilingual).length,
    speakerNumbers: [...new Set(captions.flatMap((row) => row.speakerNumber === undefined ? [] : [row.speakerNumber]))],
    translationErrorCount: captions.filter((row) => row.translationError).length,
    recentRows: rows.slice(-10),
  };
}

/** Stops the one standalone mic/socket owner; idempotent while it is opening or live. */
export async function stopFaceToFaceRuntime(): Promise<void> {
  await activeStop?.();
}

export async function startFaceToFaceRuntime(signal = new AbortController().signal, openSource?: OpenSource): Promise<() => Promise<void>> {
  if (activeStop) throw new Error('Face to Face is already starting or running.');
  const state = useFaceToFaceStore.getState();
  state.resetRun();
  const tokenSession = beginSessionTokens('face-to-face', realClock.now(), isElectron() && !openSource);
  state.setPhase('starting');
  const run: FaceToFaceDiagnostics = {
    stage: 'provider', input: openSource ? 'replay' : 'microphone', failure: null, microphoneFrames: 0, inputSamples: 0, peak: 0,
    replayedCaptions: 0, replaySamples: 0, completedReplays: 0, missingAudioRanges: 0,
    lastReplayFailure: null, lastReplayCloseCode: null, replayFrames: {},
    streamProgress: { startedEarly: 0, firstTextInputMs: [] },
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
  let replay: ReturnType<typeof createQwenFaceReplay> | undefined;
  const router = new FaceToFaceCaptions(state.languages, async (itemId, turnSignal, onText, early) => {
    if (!replay) throw new Error('The second subtitle language is not ready.');
    turnSignal.throwIfAborted();
    run.replayedCaptions += 1;
    if (early) run.streamProgress.startedEarly += 1;
    const frames = async function* () {
      for await (const pcm of audioBuffer.stream(itemId, turnSignal)) {
        run.replaySamples += pcm.length;
        yield pcm;
      }
    };
    let firstText = true;
    try {
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
  });

  const dispose = async () => {
    if (stopping) return stopping;
    lifecycle.abort();
    useFaceToFaceStore.getState().setPhase('stopping');
    stopping = (async () => {
      // A stop during socket or mic setup waits for that setup to observe abort and release anything it opened.
      await startingSettled;
      removePcm?.();
      removeEnd?.();
      router.stop();
      audioBuffer.dispose();
      const closing = session?.stop();
      const releasing = source?.stop();
      await Promise.allSettled([closing, releasing, replay?.stop()]);
      signal.removeEventListener('abort', abortFromOwner);
      if (activeStop === dispose) activeStop = null;
      finishSessionTokens('face-to-face', tokenSession, realClock.now());
      useFaceToFaceStore.getState().setPhase('idle');
    })();
    return stopping;
  };

  activeStop = dispose;
  const abortFromOwner = () => { void dispose(); };
  signal.addEventListener('abort', abortFromOwner, { once: true });
  if (signal.aborted) abortFromOwner();

  try {
    const open = async () => {
      if (!useProviderStore.getState().entries.qwen_livetranslate) {
        await useProviderStore.getState().load(qwenLiveTranslateProvider);
      }
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      const entry = useProviderStore.getState().entries.qwen_livetranslate;
      if (!entry) throw new Error('Qwen LiveTranslate settings are not loaded. Open Settings and configure Qwen first.');
      const settings = entry.settings as QwenSettings;
      const credentials = readCredentials(qwenLiveTranslateProvider, settings, entry.credentials, { signedIn: false, getToken: async () => null });
      if (isMissing(credentials)) throw new AdapterStartError(credentials.missing, 'credentials_missing');

      const context: SessionContext = { direction: { source: 'auto', target: state.languages.first }, speech: false, turns: 'auto' };
      const shared: SharedSettings = {
        pauses: { sourceSeconds: 2.5, translationSeconds: 2.5 },
        segmentation: { mode: 'pause', sentencesPerRow: 1 },
        reversed: () => true,
        models: [],
      };
      const config = buildQwen(context, settings, shared);
      if ('refused' in config) throw new Error(config.refused);
      config.activity = 'face-to-face';
      // Face to Face always needs diarization, regardless of the meeting-only speaker-label preference.
      config.person = true;
      config.detectIncomingLanguage = true;
      config.skipSameLanguageText = false;
      config.turnAudio = audioBuffer;

      const events: AdapterEvents = {
        segmentOpened: (e) => router.opened(e),
        segmentText: (e) => router.text(e),
        segmentClosed: (e) => router.closed(e.ref, e.origin),
        audio: () => {},
        speechRanges: () => {},
        closed: () => {},
        reconnecting: () => {},
        reconnected: () => {},
        failed: (e) => {
          run.failure = 'provider_failed';
          void dispose().then(() => useFaceToFaceStore.getState().setPhase('error', e.message));
        },
        degraded: () => {},
        loading: () => {},
        busy: () => {},
        frame: () => {},
      };
      const unit = qwenLiveTranslateProvider.units[0];
      if (!unit.start) throw new Error('This Qwen unit cannot start a realtime audio session.');
      const startSession = unit.start;
      const replayContext: SessionContext = { direction: { source: 'auto', target: state.languages.second }, speech: false, turns: 'manual' };
      const replayConfig = buildQwen(replayContext, settings, shared);
      if ('refused' in replayConfig) throw new Error(replayConfig.refused);
      replayConfig.activity = 'face-to-face';
      replayConfig.person = false;
      replayConfig.detectIncomingLanguage = false;
      replayConfig.skipSameLanguageText = false;
      replay = createQwenFaceReplay({
        signal: lifecycle.signal,
        start: (events, signal) => startSession({ context: replayContext, config: replayConfig, credentials, clock: realClock, signal }, {
          ...events,
          frame: (event) => {
            if (REPLAY_FRAMES.has(event.type)) run.replayFrames[event.type] = (run.replayFrames[event.type] ?? 0) + 1;
            if (event.type === 'session.closed' || event.type === 'session.connection_lost') {
              const code = (event.payload as { code?: unknown } | undefined)?.code;
              if (typeof code === 'number' && Number.isInteger(code)) run.lastReplayCloseCode = code;
            }
            events.frame(event);
          },
        }),
      });
      session = await startSession({ context, config, credentials, clock: realClock, signal: lifecycle.signal }, events);
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      run.stage = 'microphone';
      const capture = openSource ?? (await getAppSession().audio()).capture.openSource;
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      source = await capture('speaker', lifecycle.signal);
      if (lifecycle.signal.aborted) throw new DOMException('Face-to-face session cancelled.', 'AbortError');
      removePcm = source.onPcm((pcm) => {
        run.microphoneFrames += 1;
        run.inputSamples += pcm.length;
        for (const sample of pcm) run.peak = Math.max(run.peak, Math.abs(sample));
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
