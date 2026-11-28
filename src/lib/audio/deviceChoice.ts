/**
 * Which device to use, given the OS's list (spec 2026-10-04 "device follow",
 * section 1). One rule for the startup refresh, the refresh buttons and the
 * automatic sync, so the three agree — and the saved device comes first, which
 * is what switches back to the user's own device when it returns.
 */
import type { AudioDevice } from '../../stores/audioStore';
import { isLoopbackInput } from '../../utils/audioDevices';

export interface DeviceChoice {
  devices: readonly AudioDevice[];
  /** The user's own pick, as persisted; never a fallback. */
  savedId: string | null;
  /** What is selected now. */
  currentId: string | null;
  /** Inputs that failed to open this session (`audioStore.markInputUnusable`). */
  unusable?: ReadonlySet<string>;
}

/**
 * Pick a default microphone from an enumerated input list, excluding virtual
 * ones (e.g. Sokuji's own "Sokuji_Virtual_Mic" — the monitor of Sokuji's own
 * virtual speaker, meant for other apps to consume, not for Sokuji to listen
 * to itself). Returns null when only virtual/loopback devices are available
 * rather than falling back to one — auto-selecting a loopback device as the
 * mic would feed Sokuji's own TTS output back into ASR as "user speech",
 * creating a self-sustaining transcription loop (observed on machines with
 * no physical microphone, where a virtual device is the only input listed).
 *
 * OS loopback-style inputs ("Stereo Mix", PulseAudio sink monitors,
 * VoiceMeeter outputs) carry isVirtual: false — they are real OS devices and
 * must stay manually selectable (warned) — but they re-capture system output
 * just the same, so automatic selection skips them by label too.
 */
export function pickDefaultInputDevice(inputs: readonly AudioDevice[]): AudioDevice | null {
  return inputs.find((device) => !device.isVirtual && !isLoopbackInput(device)) ?? null;
}

/** The microphone to use: the saved one, else the current one, else the first real input; null when none is left. */
export function chooseInput({ devices, savedId, currentId, unusable = new Set() }: DeviceChoice): AudioDevice | null {
  const usable = devices.filter((device) => !unusable.has(device.deviceId));
  // A saved virtual device is refused: an old auto-select bug persisted Sokuji's own virtual mic.
  const saved = savedId ? usable.find((device) => device.deviceId === savedId && !device.isVirtual) : undefined;
  // A stale/current selection is no safer than a saved one: an older build or
  // a programmatic selection may have left Sokuji's virtual input selected.
  // Keep deliberately selected OS loopback inputs (they are warned in the UI),
  // but never silently retain this app's own virtual/cable endpoint.
  const current = currentId ? usable.find((device) => device.deviceId === currentId && !device.isVirtual) : undefined;
  const unsafeCurrent = currentId !== null && usable.some((device) => device.deviceId === currentId && device.isVirtual);
  // A listed but unsafe current choice is an explicit bad selection, not a
  // removed device. Clear it and let the caller show an empty picker instead
  // of silently swapping to the first physical microphone. If the OS marks it
  // unusable after an open failure, it is removed from `usable` and the usual
  // device-lost fallback path can take over with its notice.
  return saved ?? current ?? (unsafeCurrent ? null : pickDefaultInputDevice(usable));
}

/** A local monitor must never use the meeting's virtual microphone as its speaker. */
export function chooseOutput({ devices, savedId, currentId }: DeviceChoice): AudioDevice | null {
  const local = devices.filter((device) => !device.isVirtual);
  return local.find((device) => device.deviceId === savedId)
    ?? local.find((device) => device.deviceId === currentId)
    ?? local[0] ?? null;
}
