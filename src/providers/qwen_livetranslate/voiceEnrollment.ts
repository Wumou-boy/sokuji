/**
 * Renderer-side Qwen fixed-voice client. Enrollment and deletion cross a
 * narrow Electron IPC because packaged Sokuji runs from file:// and the
 * Alibaba APIs do not expose CORS. No operation runs until the user confirms
 * the reviewed recording in the voice modal.
 */
export const QWEN_ENROLLMENT_MODEL = 'qwen3.8-livetranslate-flash-realtime';
export interface QwenFixedVoice { id: string; name: string; status: string }
export type QwenVoiceInvoke = (channel: 'qwen-voice:create' | 'qwen-voice:delete', payload: Record<string, unknown>) => Promise<{
  ok: boolean; voiceId?: string; code?: string; message?: string; requestId?: string;
}>;

export class QwenVoiceError extends Error {
  constructor(message: string, readonly code: string, readonly requestId?: string) {
    super(message);
    this.name = 'QwenVoiceError';
  }
}

/** WAV PCM16 mono 24 kHz, the format and sample rate required by Alibaba's LiveTranslate enrollment guide. */
export function encodeQwenVoiceWav(samples: Float32Array, sourceRate: number): Blob {
  if (!Number.isFinite(sourceRate) || sourceRate < 8_000 || !samples.length) throw new QwenVoiceError('The recording is empty or has an invalid sample rate.', 'invalid_audio');
  const monoLength = Math.round(samples.length * 24_000 / sourceRate);
  const pcm = new ArrayBuffer(44 + monoLength * 2);
  const view = new DataView(pcm);
  const str = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, pcm.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, monoLength * 2, true);
  for (let i = 0; i < monoLength; i++) {
    const at = i * sourceRate / 24_000;
    const left = Math.min(samples.length - 1, Math.floor(at));
    const right = Math.min(samples.length - 1, left + 1);
    const value = Math.max(-1, Math.min(1, samples[left] + (samples[right] - samples[left]) * (at - left)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([pcm], { type: 'audio/wav' });
}

async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function defaultInvoke(channel: 'qwen-voice:create' | 'qwen-voice:delete', payload: Record<string, unknown>) {
  if (typeof window === 'undefined' || !window.electron?.invoke) throw new QwenVoiceError('Qwen voice enrollment is available in the Sokuji desktop app.', 'desktop_only');
  return window.electron.invoke(channel, payload) as ReturnType<QwenVoiceInvoke>;
}

export function qwenVoiceClient(apiKey: string, invoke: QwenVoiceInvoke = defaultInvoke) {
  const key = apiKey.trim();
  if (!key) throw new QwenVoiceError('Save a Bailian API key before managing fixed voices.', 'missing_key');
  return {
    async create(wav: Blob, preferredName: string, referenceUrl?: string): Promise<string> {
      const result = await invoke('qwen-voice:create', { apiKey: key, preferredName, audio: await blobBytes(wav), ...(referenceUrl?.trim() ? { referenceUrl: referenceUrl.trim() } : {}) });
      if (!result?.ok || !result.voiceId) throw new QwenVoiceError(result?.message ?? 'Alibaba did not return a voice ID.', result?.code ?? 'request_failed', result?.requestId);
      return result.voiceId;
    },
    async delete(id: string): Promise<void> {
      const result = await invoke('qwen-voice:delete', { apiKey: key, voiceId: id });
      if (!result?.ok) throw new QwenVoiceError(result?.message ?? 'Could not delete this voice.', result?.code ?? 'request_failed', result?.requestId);
    },
  };
}
