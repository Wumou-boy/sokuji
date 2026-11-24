/** Stores only IDs and labels for profiles Sokuji created; never audio or API keys. */
const STORAGE_PREFIX = 'sokuji.qwen-livetranslate-voices.v1.';

export interface StoredQwenVoice { id: string; name: string }

export async function qwenVoiceKeyFingerprint(apiKey: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure local storage is unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey.trim()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const keyFor = async (apiKey: string) => STORAGE_PREFIX + await qwenVoiceKeyFingerprint(apiKey);

function read(raw: string | null): StoredQwenVoice[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is StoredQwenVoice => v && typeof v.id === 'string' && typeof v.name === 'string');
  } catch { return []; }
}

export async function loadQwenVoiceProfiles(apiKey: string): Promise<StoredQwenVoice[]> {
  return read(localStorage.getItem(await keyFor(apiKey)));
}

/** Fail before a paid enrollment request if this profile cannot remember its returned voice ID. */
export async function ensureQwenVoiceProfileStorage(apiKey: string): Promise<void> {
  const key = `${await keyFor(apiKey)}.probe`;
  // Reserve more than the largest expected ID/name entry before any paid create call.
  localStorage.setItem(key, 'x'.repeat(2048));
  localStorage.removeItem(key);
}

export async function rememberQwenVoiceProfile(apiKey: string, profile: StoredQwenVoice): Promise<void> {
  const key = await keyFor(apiKey);
  const voices = read(localStorage.getItem(key));
  if (!voices.some((v) => v.id === profile.id)) voices.push(profile);
  localStorage.setItem(key, JSON.stringify(voices));
}

export async function forgetQwenVoiceProfile(apiKey: string, id: string): Promise<void> {
  const key = await keyFor(apiKey);
  localStorage.setItem(key, JSON.stringify(read(localStorage.getItem(key)).filter((v) => v.id !== id)));
}
