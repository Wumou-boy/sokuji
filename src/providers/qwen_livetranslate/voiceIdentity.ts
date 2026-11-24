import type { QwenVoiceChoice } from './config';
import { QWEN_VOICES } from './settings';
import { qwenVoiceKeyFingerprint } from './voiceProfileStorage';

/** A fixed voice is usable only by the Bailian key that created it. */
export async function resolveQwenVoiceForSession(
  voice: QwenVoiceChoice,
  apiKey: string,
  isBailianShared: boolean,
): Promise<QwenVoiceChoice> {
  if (voice.kind !== 'fixed') return voice;
  if (!isBailianShared || !apiKey || !voice.ownerHash) return { kind: 'preset', name: QWEN_VOICES[0].value };
  try {
    if (await qwenVoiceKeyFingerprint(apiKey) === voice.ownerHash) return voice;
  } catch { /* a missing WebCrypto implementation must not block translation */ }
  return { kind: 'preset', name: QWEN_VOICES[0].value };
}
