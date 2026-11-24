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
import { isLoopbackInput, isVirtualMic } from '../../utils/audioDevices';
import { createEchoWatch, type EchoWatch } from './capture/echoWatch';
import { createSourceCore } from './capture/core';
import { createMeetingEchoReduction } from './capture/meetingEcho';
import { openMic, type MicSettings } from './capture/mic';
import { silentSource } from './capture/silent';
import { openSystemAudio, type SystemAudioSettings } from './capture/systemAudio';
import { openTab, type TabSettings } from './capture/tab';
import { createLevelMeter, type LevelMeter } from './levelMeter';
import { createAppRouting } from './appAudio';
import type { Playback } from './playback';
import { targetTabIdFromSearch } from './tabMicrophone';

export interface AppCapture {
  openSource: OpenSource;
  /** For the echo notice (plan 1d): `useEchoNotice`'s one-listener contract. */
  echo: EchoWatch;
  /** Each leg's input spectrum for the footer's waveform: the output strip's frequency bars, over the chunks it delivers while `meterGate` lets them through. */
  levels: Readonly<Record<LegName, LevelMeter>>;
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
    autoResolved: (source) => audio().setAutoMeetingResolvedSource(source ? {
      deviceId: source.deviceId,
      label: source.label,
      appKey: source.appKey ?? null,
    } : null),
    meetingOutput: () => {
      const route = createAppRouting('electron').get();
      return audio().mode === 'both' && route.meeting && route.speak.other ? route.sinks.virtual : undefined;
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
  const meetingEcho = platform === 'electron' && windowsDesktop() ? createMeetingEchoReduction() : null;

  const micWithEchoReduction = (source: Source, reduction: NonNullable<typeof meetingEcho>): Source => {
    const core = createSourceCore({
      muted: () => false,
      release: async () => { off(); await source.stop(); },
    });
    const off = source.onPcm((pcm) => {
      const { mode, echoCancellationMode, selectedInputDevice } = audio();
      const input = selectedInputDevice;
      const physical = input && !input.isVirtual && !isVirtualMic(input) && !isLoopbackInput(input);
      core.deliver(mode === 'both' && echoCancellationMode === 'all' && physical ? reduction.reduce(pcm) : pcm);
    });
    return { ...source, onPcm: core.onPcm, stop: core.stop };
  };

  const open = (leg: LegName, signal: AbortSignal): Promise<Source> => {
    if (leg === 'speaker') return openMic(micSettings(), signal);
    if (participantBeside?.()) return Promise.resolve(silentSource());
    if (platform === 'electron') return openSystemAudio(systemAudioSettings(), signal);
    if (platform === 'extension') return openTab(tabSettings(), signal);
    return Promise.reject(new Error('This build has no participant source.'));
  };

  return {
    echo,
    levels,
    async openSource(leg, signal) {
      const raw = await open(leg, signal);
      const source = leg === 'speaker' && meetingEcho ? micWithEchoReduction(raw, meetingEcho) : raw;
      const offReference = leg === 'participant' && meetingEcho ? source.onPcm(meetingEcho.pushReference) : undefined;
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
        offReference?.();
        if (leg === 'participant') meetingEcho?.reset();
        offPassthrough();
        offLevel();
        levels[leg].reset();
        detach();
      });
    },
  };
}
