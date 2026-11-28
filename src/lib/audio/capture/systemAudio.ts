/**
 * Electron's system audio as the participant source (spec: "Sources, in
 * full"), replacing `ModernBrowserAudioService`'s sequence step by step:
 * connect the chosen source over IPC, then record it with the recorder the
 * main process asks for — the per-application helper (Windows, and macOS
 * 14.2+), a PipeWire tap's monitor device (Linux per-application), or
 * getDisplayMedia loopback (whole-system on Windows, Linux and older macOS).
 */
import { SAMPLE_RATE } from '../../contract/adapter';
import { describeCause, reportWarning } from '../../diagnostics/report';
import { AppAudioRecorder } from '../../modern-audio/AppAudioRecorder';
import { DeviceCaptureRecorder } from '../../modern-audio/DeviceCaptureRecorder';
import { LoopbackRecorder } from '../../modern-audio/LoopbackRecorder';
import { SourceOpenError, type Source } from '../../session/source';
import { createSourceCore } from './core';
import { isDedicatedMeetingInput } from '../virtualSpeaker';

export const APP_CAPTURE_LOST = 'app_capture_lost_using_system_audio';
export const APP_MONITOR_MISSING = 'app_capture_monitor_missing';
export const SILENT_NO_PERMISSION = 'silent_no_permission';
export const LOOPBACK_DENIED = 'loopback_denied';
export const LOOPBACK_MEETING_OUTPUT = 'loopback_meeting_output';
export const LOOPBACK_ENDPOINT_UNAVAILABLE = 'loopback_endpoint_unavailable';
const LOOPBACK_MEETING_OUTPUT_MESSAGE = 'Windows is using the meeting’s virtual microphone cable as its default playback device. Set Windows playback to your headphones or speakers, or select the meeting application as the participant audio source.';

/** The settings a system-audio source follows, read live. */
export interface SystemAudioSettings {
  /** The chosen participant source: system mix, an application, or one Windows render endpoint. */
  sourceId(): string;
  muted(): boolean;
  subscribe(listener: () => void): () => void;
  /** The helper heard audible audio: remembered, so a later silence reads as a permission problem (#492). */
  audioSeen(): void;
  /** The capture widened to the whole system although an application was chosen (true), or is no longer widened: it closed, or a switch landed on what was chosen (false). While on, the other's translation played on the real device would be recaptured. */
  widened(on: boolean): void;
  /** Windows playback device carrying our outgoing translation during this meeting, when enabled. */
  meetingOutput?(): string | undefined;
  captureStarted?(backend: Connection['mode']): void;
}

/** The part of a participant recorder this source drives. */
export interface ParticipantCapture {
  /** False when it cannot capture (it logs why and cleans up after itself). */
  begin(options?: { deviceId?: string }): Promise<boolean>;
  /** What the last begin() that returned false failed on, when the recorder knows. */
  beginFailure?: unknown;
  record(callback: (data: { mono: Int16Array }) => void): Promise<boolean>;
  end(): Promise<void>;
  getStream?(): MediaStream | null;
  onLost?: (() => void) | null;
  onWarning?: ((code: string) => void) | null;
  onAudioSeen?: (() => void) | null;
}

export interface SystemAudioDeps {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  wait(ms: number): Promise<void>;
  app(): ParticipantCapture;
  device(): ParticipantCapture;
  loopback(): ParticipantCapture;
  /** Windows-only shared-mode loopback recorder. */
  nativeLoopback?(): ParticipantCapture;
  /** Hears the main process say the application a PipeWire tap follows has quit; returns the unsubscribe. */
  appLost(listener: () => void): () => void;
  /** The OS's Screen Recording permission as the main process reports it (`granted`, `denied`, `not-determined`, `unknown`); outside macOS always `granted`. */
  screenRecording(): Promise<string>;
}

export const electronSystemAudio = (): SystemAudioDeps => ({
  invoke: (channel, data) => window.electron.invoke(channel, data),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  app: () => new AppAudioRecorder(SAMPLE_RATE),
  device: () => new DeviceCaptureRecorder(SAMPLE_RATE),
  loopback: () => new LoopbackRecorder(SAMPLE_RATE),
  ...(window.electron?.osInfo?.platform === 'win32' ? { nativeLoopback: () => new AppAudioRecorder(SAMPLE_RATE) } : {}),
  appLost: (listener) => {
    const handler = () => listener();
    window.electron.receive('system-audio:lost', handler);
    return () => window.electron.removeListener('system-audio:lost', handler);
  },
  screenRecording: async () => {
    try {
      const answer = (await window.electron.invoke('check-screen-recording-permission')) as { status?: unknown } | undefined;
      return typeof answer?.status === 'string' ? answer.status : 'unknown';
    } catch (error) {
      // As today's `requestLoopbackAudioStream`: a failed check is not read as a denial.
      reportWarning('SystemAudio', `Checking the Screen Recording permission failed: ${describeCause(error)}`, { cause: error, dedupeKey: 'system:screen-recording' });
      return 'unknown';
    }
  },
});

type Connection =
  | { mode: 'app' }
  | { mode: 'device'; monitorId: string; dedicated?: boolean }
  | { mode: 'loopback' }
  | { mode: 'native-loopback'; makeRecorder(): ParticipantCapture }
  | { mode: 'endpoint'; endpointId: string; makeRecorder(): ParticipantCapture };

interface ConnectAnswer {
  success?: boolean;
  error?: string;
  capture?: string;
  monitorLabel?: string;
}

const SILENT_MESSAGE =
  'No audio has come through from the selected source yet: it may be silent, or Sokuji may lack permission to record it.';

/** A capture endpoint can briefly reject an open while Windows is settling a tap. */
function isTransientCaptureOpenFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'NotReadableError';
}

export async function openSystemAudio(
  settings: SystemAudioSettings,
  signal: AbortSignal,
  deps: SystemAudioDeps = electronSystemAudio(),
): Promise<Source> {
  signal.throwIfAborted();
  let sourceId = settings.sourceId();
  let captureSourceId = sourceId;
  let recorder: ParticipantCapture | null = null;
  let connected = false;
  let unwatch = () => {};
  let unlisten = () => {};
  let unsubscribe = () => {};
  let chain: Promise<void> = Promise.resolve();
  let selection = 0;

  /** Ends the recorder: its `onLost` detached first, since its own teardown kills the helper. */
  const stopRecorder = async () => {
    const current = recorder;
    recorder = null;
    unwatch();
    unwatch = () => {};
    unlisten();
    unlisten = () => {};
    if (!current) return;
    current.onLost = null;
    try {
      await current.end();
    } catch (error) {
      reportWarning('SystemAudio', `Stopping the system audio capture failed: ${describeCause(error)}`, { dedupeKey: 'system:end' });
    }
  };

  const close = async () => {
    await stopRecorder();
    settings.widened(false);
    if (!connected) return;
    connected = false;
    try {
      await deps.invoke('disconnect-system-audio-source');
    } catch (error) {
      reportWarning('SystemAudio', `Disconnecting the system audio source failed: ${describeCause(error)}`, { dedupeKey: 'system:disconnect' });
    }
  };

  const core = createSourceCore({
    muted: () => settings.muted(),
    release: async () => {
      signal.removeEventListener('abort', stop);
      unsubscribe();
      await chain;
      await close();
    },
  });
  const stop = () => { void core.stop(); };
  const current = (id: number) => id === selection && !signal.aborted && !core.stopped && !core.ended;

  /** A PipeWire tap's sink appears in the browser's device list a moment after it is created: retry briefly. */
  const findMonitor = async (label: string): Promise<string | undefined> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const match = (await deps.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label.includes(label));
      if (match) return match.deviceId;
      await deps.wait(100);
    }
    return undefined;
  };

  const connect = async (id: string, generation = selection): Promise<Connection> => {
    captureSourceId = id;
    if (id.startsWith('cable:')) {
      const monitorId = id.slice('cable:'.length);
      const match = deps.nativeLoopback && (await deps.enumerateDevices()).some((d) =>
        d.kind === 'audioinput' && d.deviceId === monitorId && isDedicatedMeetingInput(d.label));
      if (!match) throw new SourceOpenError('The selected meeting audio cable is unavailable.', LOOPBACK_ENDPOINT_UNAVAILABLE);
      return { mode: 'device', monitorId, dedicated: true };
    }
    const answer = (await deps.invoke('connect-system-audio-source', id)) as ConnectAnswer | undefined;
    if (id.startsWith('endpoint:')) {
      if (!answer?.success || answer.capture !== 'endpoint' || !deps.nativeLoopback) {
        throw new SourceOpenError('The selected Windows playback device is unavailable.', LOOPBACK_ENDPOINT_UNAVAILABLE);
      }
      connected = true;
      return { mode: 'endpoint', endpointId: id, makeRecorder: deps.nativeLoopback };
    }
    if (answer?.success === false) throw new Error(answer.error || 'The system audio source did not connect.');
    connected = true;
    if (answer?.capture === 'app') return { mode: 'app' };
    if (answer?.monitorLabel) {
      const monitorId = await findMonitor(answer.monitorLabel);
      if (monitorId) return { mode: 'device', monitorId };
      // The asynchronous monitor lookup can finish after a manual source
      // change. Its result belongs to the old selection and must not change
      // the current UI or report a degradation for it.
      if (!current(generation)) return { mode: 'loopback' };
      // Widening from one application to the whole system must be visible.
      settings.widened(true);
      core.degrade({ code: APP_MONITOR_MISSING, message: 'The application capture did not appear, so all system audio is being translated instead.' });
    }
    return { mode: 'loopback' };
  };

  const record = async (connection: Connection, generation = selection): Promise<void> => {
    const id = generation;
    if (deps.nativeLoopback && (connection.mode === 'loopback' || connection.mode === 'native-loopback')) {
      const meetingOutput = settings.meetingOutput?.();
      if (meetingOutput) {
        const outputs = (await deps.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audiooutput');
        const defaultOutput = outputs.find((d) => d.deviceId === 'default');
        const cable = outputs.find((d) => d.deviceId === meetingOutput);
        if (defaultOutput?.groupId && defaultOutput.groupId === cable?.groupId && cable.label && defaultOutput.label.endsWith(cable.label)) {
          throw new SourceOpenError(LOOPBACK_MEETING_OUTPUT_MESSAGE, LOOPBACK_MEETING_OUTPUT);
        }
      }
    }
    // Today's `requestLoopbackAudioStream` denial (MainPanel's Screen Recording
    // modal): the start fails (D22) with a code the idle surface puts into
    // words and plan 1e-3b's modal deep-links from. Asked only before a
    // whole-system loopback. (A fall-back to loopback mid-run that meets a
    // denial ends the source through the existing chain's `core.end`.)
    if (connection.mode === 'loopback' && (await deps.screenRecording()) === 'denied') {
      throw new SourceOpenError('Screen Recording permission is denied, so the whole system cannot be captured.', LOOPBACK_DENIED);
    }
    const next = connection.mode === 'app' ? deps.app() : connection.mode === 'device' ? deps.device()
      : connection.mode === 'native-loopback' || connection.mode === 'endpoint' ? connection.makeRecorder() : deps.loopback();
    const lose = () => {
      // Captured now: by the time this runs, a queued switch may have already
      // made `recorder` point elsewhere, and this death is then stale (M1).
      const lost = next;
      chain = chain.then(() => {
        if (current(id)) return fallBack(lost);
      }).catch((error: unknown) => core.end(`System audio stopped: ${describeCause(error)}`));
    };
    if (connection.mode === 'app') {
      next.onWarning = (code) => core.degrade({ code, message: code === SILENT_NO_PERMISSION ? SILENT_MESSAGE : `The application capture warned: ${code}` });
      next.onAudioSeen = () => settings.audioSeen();
      next.onLost = lose;
    }
    if (connection.mode === 'native-loopback') {
      next.onLost = () => core.end('Windows system audio capture stopped.');
    }
    if (connection.mode === 'endpoint') {
      next.onLost = () => core.end('The selected Windows playback device stopped.');
    }
    // A PipeWire tap's monitor device outlives the application it follows (its
    // sink is Sokuji's), so the main process says when the application quit (#617).
    if (connection.mode === 'device' && !connection.dedicated) unlisten = deps.appLost(lose);
    recorder = next;
    const options = connection.mode === 'app' ? { deviceId: captureSourceId } : connection.mode === 'device' ? { deviceId: connection.monitorId }
      : connection.mode === 'native-loopback' ? { deviceId: 'desktop-audio-loopback' }
        : connection.mode === 'endpoint' ? { deviceId: connection.endpointId } : undefined;
    let begun = await next.begin(options);
    if (!begun && isTransientCaptureOpenFailure(next.beginFailure) && !signal.aborted && !core.stopped && !core.ended) {
      // Retry the exact same selected capture once. In particular, an
      // application tap stays attached to its chosen monitor; a failed open
      // must never silently turn into whole-system loopback.
      reportWarning('SystemAudio', 'The selected audio capture could not be opened temporarily; retrying once with the same source.');
      await deps.wait(250);
      if (recorder === next && !signal.aborted && !core.stopped && !core.ended) begun = await next.begin(options);
    }
    // The capture was lost while this started, and the fallback has replaced
    // it: its end() came before there was anything to end, so end it now, or
    // it would record alongside the fallback; a failed start is the fallback's
    // to own, not to clear.
    if (recorder !== next) {
      if (begun) await next.end();
      return;
    }
    if (!begun) {
      recorder = null;
      if (connection.mode === 'loopback' && sourceId === 'desktop-audio-loopback' && deps.nativeLoopback
        && isTransientCaptureOpenFailure(next.beginFailure) && !signal.aborted && !core.stopped && !core.ended) {
        reportWarning('SystemAudio', 'Switching system audio to the Windows shared-mode capture backend.');
        await record({ mode: 'native-loopback', makeRecorder: deps.nativeLoopback });
        return;
      }
      // The recorder's own reason (a DOMException's kind and words, or the
      // helper's answer) is the only clue to why; without it the start
      // failure and its telemetry say nothing about the cause.
      const why = next.beginFailure === undefined ? '' : ` (${describeCause(next.beginFailure)})`;
      throw new Error(`The system audio capture did not start${why}.`);
    }
    unwatch = core.watch(next.getStream?.() ?? null);
    await next.record((data) => {
      if (!current(id)) return;
      if (settings.muted()) return;
      core.deliver(data.mono);
    });
    if (current(id)) settings.captureStarted?.(connection.mode);
  };

  /**
   * The helper died, or the application a PipeWire tap follows quit: widen to
   * whole-system capture, visibly (ruling 5). Only when the dead recorder is
   * still the current one — a queued switch may already have replaced it, in
   * which case this death is stale (M1).
   */
  const fallBack = async (lost: ParticipantCapture) => {
    if (core.stopped || core.ended || recorder !== lost) return;
    const id = selection;
    settings.widened(true);
    await stopRecorder();
    if (!current(id)) return;
    await record({ mode: 'loopback' }, id);
    if (current(id)) core.degrade({ code: APP_CAPTURE_LOST, message: 'The application capture stopped, so all system audio is being translated instead.' });
  };

  try {
    await record(await connect(sourceId));
  } catch (error) {
    await close();
    throw error;
  }
  if (signal.aborted) {
    await core.stop();
    throw signal.reason ?? new Error('aborted');
  }

  unsubscribe = settings.subscribe(() => {
    const next = settings.sourceId();
    if (next === sourceId) return;
    sourceId = next;
    const id = ++selection;
    settings.widened(false);
    chain = chain
      .then(async () => {
        if (!current(id)) return;
        await close();
        if (!current(id)) return;
        const connection = await connect(next, id);
        if (current(id)) await record(connection, id);
      })
      .catch((error: unknown) => {
        // A rejected IPC/device lookup from a superseded selection must not
        // end the source that the user has already moved to.
        if (current(id)) core.end(`The participant source could not switch: ${describeCause(error)}`);
      });
  });
  signal.addEventListener('abort', stop, { once: true });
  return core;
}
