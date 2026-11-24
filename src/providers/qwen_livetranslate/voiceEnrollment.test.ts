import { describe, it, expect, vi } from 'vitest';
import { encodeQwenVoiceWav, qwenVoiceClient, QwenVoiceError, QWEN_ENROLLMENT_MODEL, type QwenVoiceInvoke } from './voiceEnrollment';

async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('Qwen LiveTranslate voice enrollment IPC client', () => {
  it('encodes mono PCM16 WAV at 24 kHz', async () => {
    const blob = encodeQwenVoiceWav(new Float32Array([0, 0.5, -0.5, 1]), 48_000);
    const bytes = new Uint8Array(await blobBytes(blob));
    expect(blob.type).toBe('audio/wav');
    expect(Array.from(bytes.slice(0, 4))).toEqual(Array.from(new TextEncoder().encode('RIFF')));
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(24_000);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(4);
    expect(blob.size).toBe(48);
  });

  it('sends the confirmed audio and fixed model through the narrow Electron IPC seam', async () => {
    const invoke = vi.fn(async (...args: Parameters<QwenVoiceInvoke>) => {
      const [channel] = args;
      return channel === 'qwen-voice:create'
        ? { ok: true, voiceId: `${QWEN_ENROLLMENT_MODEL}-sokuji-1234` }
        : { ok: true };
    });
    const client = qwenVoiceClient('bailian-secret', invoke);
    const wav = encodeQwenVoiceWav(new Float32Array(24_000), 24_000);
    const id = await client.create(wav, 'My Voice!');

    expect(id).toBe(`${QWEN_ENROLLMENT_MODEL}-sokuji-1234`);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('qwen-voice:create');
    expect(invoke.mock.calls[0][1]).toMatchObject({ apiKey: 'bailian-secret', preferredName: 'My Voice!' });
    expect(invoke.mock.calls[0][1].audio).toBeInstanceOf(ArrayBuffer);
    await client.delete(id);
    expect(invoke.mock.calls[1][0]).toBe('qwen-voice:delete');
  });

  it('returns enrollment errors without a renderer-side network fallback', async () => {
    const invoke = vi.fn(async (...args: Parameters<QwenVoiceInvoke>) => {
      void args;
      return { ok: false, code: 'InvalidParameter', message: 'Rejected', requestId: 'req-1' };
    });
    await expect(qwenVoiceClient('private-key', invoke).delete('voice-id')).rejects.toMatchObject({
      code: 'InvalidParameter', requestId: 'req-1',
    } satisfies Partial<QwenVoiceError>);
    expect(invoke).toHaveBeenCalledWith('qwen-voice:delete', { apiKey: 'private-key', voiceId: 'voice-id' });
  });
});
