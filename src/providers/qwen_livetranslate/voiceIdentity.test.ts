import { describe, expect, it } from 'vitest';
import { qwenVoiceKeyFingerprint } from './voiceProfileStorage';
import { resolveQwenVoiceForSession } from './voiceIdentity';

describe('Qwen fixed voice identity', () => {
  it('keeps a fixed profile only for its owning Bailian shared key', async () => {
    const ownerHash = await qwenVoiceKeyFingerprint('bailian-key');
    const fixed = { kind: 'fixed' as const, id: 'qwen3.8-livetranslate-flash-realtime-123', ownerHash };
    await expect(resolveQwenVoiceForSession(fixed, 'bailian-key', true)).resolves.toEqual(fixed);
    await expect(resolveQwenVoiceForSession(fixed, 'different-key', true)).resolves.toEqual({ kind: 'preset', name: 'Tina' });
    await expect(resolveQwenVoiceForSession(fixed, 'bailian-key', false)).resolves.toEqual({ kind: 'preset', name: 'Tina' });
  });

  it('leaves built in voices unchanged', async () => {
    const preset = { kind: 'preset' as const, name: 'Cindy' };
    await expect(resolveQwenVoiceForSession(preset, '', false)).resolves.toEqual(preset);
  });
});
