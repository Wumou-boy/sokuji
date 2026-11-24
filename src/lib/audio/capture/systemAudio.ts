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

export const APP_CAPTURE_LOST = 'app_capture_lost_using_system_audio';
export const APP_MONITOR_MISSING = 'app_capture_monitor_missing';
export const SILENT_NO_PERMISSION = 'silent_no_permission';
export const LOOPBACK_DENIED = 'loopback_denied';
export const LOOPBACK_MEETING_OUTPUT = 'loopback_meeting_output';
export const AUTO_MEETING_SOURCE = 'auto-meeting-audio';
const AUTO_PROBE_INTERVAL_MS = 1_500;

const LOOPBACK_MEETING_OUTPUT_MESSAGE = 'Windows is using the meeting’s virtual microphone cable as its default playback device. Set Windows playback to your headphones or speakers, or select the meeting application as the participant audio source.';

interface ResolvedApp {
  deviceId: string;
  label: string;
  appKey?: string | null;
}

/** The settings a system-audio source follows, read live. */
export interface SystemAudioSettings {
  /** The chosen participant source: 'desktop-audio-loopback' (the whole system) or an 'app:…' id. */
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
  autoResolved?(source: ResolvedApp | null): void;
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
  /** Windows-only shared-mode loopback on the same default render endpoint. */
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

type Connection = { mode: 'app' } | { mode: 'device'; monitorId: string } | { mode: 'loopback' } | { mode: 'native-loopback'; makeRecorder(): ParticipantCapture };

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
  let probeTimer: ReturnType<typeof setTimeout> | undefined;

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
    settings.autoResolved?.(null);
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
      clearTimeout(probeTimer);
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

  const connect = async (id: string, requireApp = false): Promise<Connection> => {
    captureSourceId = id;
    const answer = (await deps.invoke('connect-system-audio-source', id)) as ConnectAnswer | undefined;
    if (answer?.success === false) throw new Error(answer.error || 'The system audio source did not connect.');
    if (requireApp && answer?.capture !== 'app') throw new Error('Auto requires application audio capture.');
    connected = true;
    if (answer?.capture === 'app') return { mode: 'app' };
    if (answer?.monitorLabel) {
      const monitorId = await findMonitor(answer.monitorLabel);
      if (monitorId) return { mode: 'device', monitorId };
      // Widening from one application to the whole system must be visible.
      settings.widened(true);
      core.degrade({ code: APP_MONITOR_MISSING, message: 'The application capture did not appear, so all system audio is being translated instead.' });
    }
    return { mode: 'loopback' };
  };

  // Probe one round at a time. A silent or closed meeting app leaves this
  // leg waiting, and a source change invalidates any probe already in flight.
  const scheduleProbe = (id: number, delay = 0) => {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      chain = chain.then(() => probe(id));
    }, delay);
  };
  const probe = async (id: number) => {
    if (!current(id)) return;
    try {
      const resolution = await deps.invoke('resolve-auto-system-audio-source') as { success?: boolean; source?: ResolvedApp } | undefined;
      if (!current(id)) return;
      const source = resolution?.success === true ? resolution.source : undefined;
      if (source?.deviceId?.startsWith('app:')) {
        const connection = await connect(source.deviceId, true);
        if (!current(id)) return;
        await record(connection);
        if (current(id)) settings.autoResolved?.(source);
        return;
      }
    } catch (error) {
      reportWarning('SystemAudio', 'Automatic meeting audio could not connect yet.', { cause: error, dedupeKey: 'system:auto-connect' });
      await close();
    }
    if (current(id)) scheduleProbe(id, AUTO_PROBE_INTERVAL_MS);
  };

  const record = async (connection: Connection): Promise<void> => {
    const id = selection;
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
      : connection.mode === 'native-loopback' ? connection.makeRecorder() : deps.loopback();
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
    // A PipeWire tap's monitor device outlives the application it follows (its
    // sink is Sokuji's), so the main process says when the application quit (#617).
    if (connection.mode === 'device') unlisten = deps.appLost(lose);
    recorder = next;
    const options = connection.mode === 'app' ? { deviceId: captureSourceId } : connection.mode === 'device' ? { deviceId: connection.monitorId }
      : connection.mode === 'native-loopback' ? { deviceId: 'desktop-audio-loopback' } : undefined;
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
    await next.record((data) => { if (current(id)) core.deliver(data.mono); });
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
    if (sourceId === AUTO_MEETING_SOURCE) {
      const id = selection;
      await close();
      if (current(id)) scheduleProbe(id);
      return;
    }
    settings.widened(true);
    await stopRecorder();
    await record({ mode: 'loopback' });
    core.degrade({ code: APP_CAPTURE_LOST, message: 'The application capture stopped, so all system audio is being translated instead.' });
  };

  if (sourceId !== AUTO_MEETING_SOURCE) {
    try {
      await record(await connect(sourceId));
    } catch (error) {
      await close();
      throw error;
    }
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
    clearTimeout(probeTimer);
    chain = chain
      .then(async () => {
        if (!current(id)) return;
        await close();
        if (!current(id)) return;
        if (next === AUTO_MEETING_SOURCE) scheduleProbe(id);
        else {
          const connection = await connect(next);
          if (current(id)) await record(connection);
        }
      })
      .catch((error: unknown) => core.end(`The participant source could not switch: ${describeCause(error)}`));
  });
  signal.addEventListener('abort', stop, { once: true });
  if (sourceId === AUTO_MEETING_SOURCE) {
    settings.autoResolved?.(null);
    scheduleProbe(selection);
  }
  return core;
}
