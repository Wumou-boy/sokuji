import { afterEach, describe, expect, it } from 'vitest';
import { forgetQwenVoiceProfile, loadQwenVoiceProfiles, rememberQwenVoiceProfile } from './voiceProfileStorage';

describe('Qwen fixed voice profile storage', () => {
  afterEach(() => localStorage.clear());

  it('persists names and IDs per API key without persisting the API key itself', async () => {
    const profile = { id: 'qwen-translate-vc-own-1', name: 'My voice' };
    await rememberQwenVoiceProfile('secret-one', profile);
    expect(await loadQwenVoiceProfiles('secret-one')).toEqual([profile]);
    expect(await loadQwenVoiceProfiles('secret-two')).toEqual([]);
    expect(Object.keys(localStorage)).toHaveLength(1);
    expect(Object.keys(localStorage)[0]).not.toContain('secret-one');
    expect(localStorage.getItem(Object.keys(localStorage)[0])).not.toContain('secret-one');
  });

  it('removes only the selected profile', async () => {
    await rememberQwenVoiceProfile('key', { id: 'one', name: 'One' });
    await rememberQwenVoiceProfile('key', { id: 'two', name: 'Two' });
    await forgetQwenVoiceProfile('key', 'one');
    expect(await loadQwenVoiceProfiles('key')).toEqual([{ id: 'two', name: 'Two' }]);
  });
});
