/** Immutable source identity for the session-local CAM++ embedding model. */
export const SPEAKER_MODEL = Object.freeze({
  id: 'aed-camplus-v1',
  filename: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  get url(): string {
    const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
    const hubBase = env?.VITE_HF_HUB_BASE || env?.VITE_TRANSLATION_CDN_BASE || 'https://huggingface.co';
    return `${hubBase.replace(/\/$/, '')}/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`;
  },
  sha256: '53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b',
  sizeBytes: 28_281_165,
  sampleRate: 16_000,
  embeddingDimensions: 192,
});
export class ModelIntegrityError extends Error {}

export async function verifiedSpeakerModel(blob: Blob): Promise<Uint8Array> {
  if (blob.size !== SPEAKER_MODEL.sizeBytes) {
    throw new ModelIntegrityError(`CAM++ model size mismatch: got ${blob.size} bytes`);
  }
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== SPEAKER_MODEL.sha256) throw new ModelIntegrityError('CAM++ model SHA-256 mismatch');
  return new Uint8Array(buffer);
}
