import { isLinux, isWindows } from '../../utils/environment';

const STANDARD_VB_CABLE_INPUT = /^cable input(?: \((?:\d+-\s*)?vb-audio virtual cable\))?$/i;
const SEPARATE_VB_CABLE_OUTPUT = /^cable-[abcd] output\s*\((?:\d+-\s*)?vb-audio cable [abcd]\)$/i;

/** Additional cable pairs reserved for incoming meeting audio. Standard VB-CABLE carries our outgoing voice. */
export const isDedicatedMeetingInput = (label: string) => SEPARATE_VB_CABLE_OUTPUT.test(label.trim());

/**
 * The output device a meeting app hears as a microphone (Electron), found by
 * label in this order: Linux's PulseAudio sink, macOS's driver, Windows'
 * standard VB-CABLE input. CABLE In 16ch is a different endpoint from the
 * one that feeds the standard CABLE Output microphone.
 */
export function findVirtualSpeaker(outputs: readonly { deviceId: string; label: string }[]): string | undefined {
  const match = outputs.find((d) => d.label.includes('Sokuji_Virtual_Speaker'))
    ?? outputs.find((d) => d.label.includes('SokujiVirtualAudio'))
    ?? outputs.find((d) => STANDARD_VB_CABLE_INPUT.test(d.label.trim()));
  return match?.deviceId;
}

/**
 * The virtual microphone's name as the user's meeting app lists it (spec
 * 2026-10-10 §7): the input side of the device `findVirtualSpeaker` plays
 * into. Linux's PulseAudio remap, macOS's driver, Windows' VB-Cable.
 */
export function virtualMicrophoneName(): string {
  if (isLinux()) return 'Sokuji_Virtual_Mic';
  if (isWindows()) return 'CABLE Output (VB-Audio Virtual Cable)';
  return 'SokujiVirtualAudio';
}
