/**
 * The page's capture — with `appAudio.ts`, the only modules in `src/lib/audio`
 * that read the stores. Opens each leg's source for the platform, feeds the
 * microphone into playback's passthrough route and both legs into the echo
 * watch, and reads the settings the sources follow, live, from `audioStore`.
 */
import type { LegName } from '../conversation/types';
import type { Platform } from '../provider/types';
import type { OpenSource, Source } from '../session/source';
import useAudioStore from '../../stores/audioStore';
import useLogStore from '../../stores/logStore';
import { useScreenContextStore } from '../../stores/screenContextStore';
import { getEnvironment } from '../../utils/environment';
import { createEchoWatch, type EchoWatch } from './capture/echoWatch';
import { openMic, type MicSettings } from './capture/mic';
import { silentSource } from './capture/silent';
import { openSystemAudio, type SystemAudioSettings } from './capture/systemAudio';
import { openTab, type TabSettings } from './capture/tab';
import { createLevelMeter, type LevelMeter } from './levelMeter';
import type { Playback } from './playback';
import { targetTabIdFromSearch } from './tabMicrophone';
import { SAMPLE_RATE } from '../contract/adapter';

const PARTICIPANT_PCM_THRESHOLD = 0.012;
const PARTICIPANT_PCM_THRESHOLD_INT16 = Math.ceil(PARTICIPANT_PCM_THRESHOLD * 32768);

export interface AppCapture {
  openSource: OpenSource;
  /** For the echo notice (plan 1d): `useEchoNotice`'s one-listener contract. */
  echo: EchoWatch;
  /** Each leg's input spectrum for the footer's waveform: the output strip's frequency bars, over the chunks it delivers while `meterGate` lets them through. */
  levels: Readonly<Record<LegName, LevelMeter>>;
  /** Read-only participant signal diagnostics; samples continue unchanged to the provider. */
  participantPcmRuntime(): ParticipantPcmRuntimeSnapshot | null;
}

export interface ParticipantPcmRuntimeSnapshot {
  sampleRate: number;
  threshold: number;
  totalSamples: number;
  blocksAtOrAboveThreshold: number;
  samplesInThresholdBlocks: number;
  thresholdBlockDurationMs: number;
}

interface MutableParticipantPcmRuntime {
  totalSamples: number;
  blocksAtOrAboveThreshold: number;
  samplesInThresholdBlocks: number;
}

const audio = () => useAudioStore.getState();
const onAudioChange = (listener: () => void) => useAudioStore.subscribe(() => listener());
const windowsDesktop = () => (window as { electron?: { osInfo?: { platform?: unknown } } }).electron?.osInfo?.platform === 'win32';

/** Asks the main process which applications are using a microphone (spec 2026-10-13 §1); null when it cannot tell. */
async function appsUsing(label: string): Promise<string[] | null> {
  try {
    const answer = (await window.electron.invoke('list-microphone-users', label)) as { ok?: unknown; users?: unknown } | undefined;
    if (answer?.ok !== true || !Array.isArray(answer.users)) return null;
    return answer.users.filter((user): user is string => typeof user === 'string');
  } catch {
    return null;
  }
}

export function micSettings(): MicSettings {
  // Windows desktop: the preload's `osInfo` says so (it is absent in the extension and on the web).
  return {
    devicesLoaded: () => audio().devicesLoaded,
    deviceId: () => audio().selectedInputDevice?.deviceId,
    deviceLabel: () => audio().selectedInputDevice?.label,
    isListed: (id) => audio().audioInputDevices.some((device) => device.deviceId === id),
    isUnusable: (id) => audio().unusableInputIds.includes(id),
    markUnusable: (id) => audio().markInputUnusable(id),
    noiseSuppression: () => audio().noiseSuppressionMode,
    echoCancellation: () => audio().echoCancellationMode,
    captureStarted: (requested, applied) => {
      const type = 'audio.capture.mic';
      const echoCancellation = applied === 'all' || applied === 'remote-only' || typeof applied === 'boolean' ? applied : 'unknown';
      useLogStore.getState().addRealtimeEvent({ type, data: { requested, applied: echoCancellation } }, 'client', type);
    },
    muted: () => audio().isMicMuted,
    subscribe: onAudioChange,
    ...(windowsDesktop() ? { appsUsing } : {}),
  };
}

export function systemAudioSettings(): SystemAudioSettings {
  return {
    sourceId: () => audio().selectedParticipantSource?.deviceId ?? 'desktop-audio-loopback',
    muted: () => audio().isParticipantMuted,
    subscribe: onAudioChange,
    audioSeen: () => audio().markParticipantTapAudioSeen(),
    widened: (on) => audio().setParticipantCaptureWidened(on),
    captureStarted: (backend) => {
      const type = 'audio.capture.participant';
      useLogStore.getState().addRealtimeEvent({ type, data: { backend } }, 'client', type);
    },
  };
}

export function tabSettings(): TabSettings {
  return {
    tabId: () => targetTabIdFromSearch(window.location.search),
    outputDeviceId: () => audio().selectedMonitorDevice?.deviceId,
    muted: () => audio().isParticipantMuted,
    // While screen context holds the tab's picture its audio and video are one capture (Chrome allows one per tab): the
    // participant leg joins it. Without a held sampler (switched off, or the screen path failed or showed nothing) the
    // audio asks for no video, so the screen path can never take the participant leg down.
    video: () => useScreenContextStore.getState().sampler !== null,
  };
}

/** The source, with `cleanup` run once before it stops. */
function withCleanup(source: Source, cleanup: () => void): Source {
  let cleaned = false;
  return {
    onPcm: (listener) => source.onPcm(listener),
    onEnded: (listener) => source.onEnded(listener),
    onDegraded: (listener) => source.onDegraded(listener),
    async stop() {
      if (!cleaned) {
        cleaned = true;
        cleanup();
      }
      await source.stop();
    },
  };
}

export interface AppCaptureOptions {
  /** Checked per chunk: false, and the leg's meter reads flat. Absent: every chunk moves it. */
  meterGate?(leg: LegName): boolean;
  /** Read at open: the participant is beside me (face-to-face) and captures nothing. Absent: never. */
  participantBeside?(): boolean;
}

export function createAppCapture(playback: Playback, platform: Platform = getEnvironment(), options: AppCaptureOptions = {}): AppCapture {
  const { meterGate, participantBeside } = options;
  const echo = createEchoWatch(playback.ttsTap);
  const levels: Record<LegName, LevelMeter> = { speaker: createLevelMeter(), participant: createLevelMeter() };
  let activeParticipantPcm: MutableParticipantPcmRuntime | null = null;

  const open = async (leg: LegName, signal: AbortSignal): Promise<Source> => {
    if (leg === 'speaker') return openMic(micSettings(), signal);
    if (participantBeside?.()) return Promise.resolve(silentSource());
    if (platform === 'electron') {
      return openSystemAudio(systemAudioSettings(), signal);
    }
    if (platform === 'extension') return openTab(tabSettings(), signal);
    return Promise.reject(new Error('This build has no participant source.'));
  };

  return {
    echo,
    levels,
    participantPcmRuntime() {
      const current = activeParticipantPcm;
      if (!current) return null;
      return {
        sampleRate: SAMPLE_RATE,
        threshold: PARTICIPANT_PCM_THRESHOLD,
        totalSamples: current.totalSamples,
        blocksAtOrAboveThreshold: current.blocksAtOrAboveThreshold,
        samplesInThresholdBlocks: current.samplesInThresholdBlocks,
        thresholdBlockDurationMs: current.samplesInThresholdBlocks / SAMPLE_RATE * 1000,
      };
    },
    async openSource(leg, signal) {
      const source = await open(leg, signal);
      // Observe the gated participant stream without changing any provider PCM.
      const participantPcm = leg === 'participant'
        ? { totalSamples: 0, blocksAtOrAboveThreshold: 0, samplesInThresholdBlocks: 0 }
        : null;
      if (participantPcm) activeParticipantPcm = participantPcm;
      const offParticipantPcm = participantPcm
        ? source.onPcm((pcm) => {
            participantPcm.totalSamples += pcm.length;
            if (pcm.some((sample) => Math.abs(sample) >= PARTICIPANT_PCM_THRESHOLD_INT16)) {
              participantPcm.blocksAtOrAboveThreshold++;
              participantPcm.samplesInThresholdBlocks += pcm.length;
            }
          })
        : () => {};
      // The processed microphone is the original voice under the translation.
      const offPassthrough = leg === 'speaker' ? source.onPcm((pcm) => playback.passthrough(pcm)) : () => {};
      // A gate that shuts flattens the meter at its next chunk, not a stale
      // spell later: reset once on the way in, never per chunk.
      let metering = true;
      const offLevel = source.onPcm((pcm) => {
        if (!meterGate || meterGate(leg)) {
          metering = true;
          levels[leg].push(pcm);
        } else if (metering) {
          metering = false;
          levels[leg].reset();
        }
      });
      const detach = echo.attach(leg, source);
      return withCleanup(source, () => {
        offParticipantPcm();
        if (activeParticipantPcm === participantPcm) activeParticipantPcm = null;
        offPassthrough();
        offLevel();
        levels[leg].reset();
        detach();
      });
    },
  };
}
