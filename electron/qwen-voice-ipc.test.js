import { describe, expect, it, vi } from 'vitest';
import { registerQwenVoiceIpc } from './qwen-voice-ipc';

const model = 'qwen3.8-livetranslate-flash-realtime';
const policy = {
  policy: 'temporary-policy', signature: 'temporary-signature', upload_dir: 'voice/enrollment',
  upload_host: 'https://files.oss-cn-beijing.aliyuncs.com', oss_access_key_id: 'temporary-id',
  x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', max_file_size_mb: '10',
};

function wav10Seconds() {
  const audio = new ArrayBuffer(44 + 24_000 * 2 * 10);
  const view = new DataView(audio);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, audio.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, audio.byteLength - 44, true);
  return audio;
}

function handlers(fetchImpl) {
  const values = new Map();
  registerQwenVoiceIpc({ ipcMain: { handle: (channel, handler) => values.set(channel, handler) }, isTrustedSender: (sender) => sender?.trusted === true, fetchImpl });
  const sender = { trusted: true, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  return { values, event, call: (channel, args) => values.get(channel)(event, args) };
}

describe('Qwen voice enrollment Electron IPC', () => {
  it('uploads only bounded WAV through the returned temporary HTTPS host and enrolls the matching LiveTranslate model', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/uploads?')) return new Response(JSON.stringify({ data: policy }), { status: 200 });
      if (String(url) === policy.upload_host) return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ output: { voice: `${model}-sokuji-voice` }, request_id: 'req-create' }), { status: 200 });
    });
    const { call } = handlers(fetchImpl);
    const result = await call('qwen-voice:create', { apiKey: 'bailian-key', preferredName: 'My Voice!', audio: wav10Seconds() });
    expect(result).toMatchObject({ ok: true, voiceId: `${model}-sokuji-voice`, requestId: 'req-create' });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(`https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${model}`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer bailian-key');
    expect(calls[1].url).toBe(`${policy.upload_host}/`);
    expect(calls[1].init.body.get('x-oss-object-acl')).toBe('private');
    expect(calls[1].init.body.get('file')).toBeInstanceOf(Blob);
    expect(calls[2].url).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization');
    expect(calls[2].init.headers['X-DashScope-OssResourceResolve']).toBe('enable');
    expect(JSON.parse(calls[2].init.body)).toMatchObject({
      model: 'qwen-voice-enrollment', input: { action: 'create', target_model: model, preferred_name: 'MyVoice', audio: { data: expect.stringMatching(/^oss:\/\//) } },
    });
  });

  it('rejects untrusted renderer frames and malformed audio before network access', async () => {
    const fetchImpl = vi.fn();
    const { values, call } = handlers(fetchImpl);
    const handler = values.get('qwen-voice:create');
    const sender = { trusted: false, mainFrame: {} };
    await expect(handler({ sender, senderFrame: sender.mainFrame }, { apiKey: 'key', audio: wav10Seconds() })).resolves.toMatchObject({ code: 'invalid_sender' });
    await expect(call('qwen-voice:create', { apiKey: 'key', audio: new ArrayBuffer(44) })).resolves.toMatchObject({ code: 'invalid_audio' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates the policy upload destination before uploading audio', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { ...policy, upload_host: 'https://attacker.example/upload' } }), { status: 200 }));
    const { call } = handlers(fetchImpl);
    await expect(call('qwen-voice:create', { apiKey: 'key', audio: wav10Seconds() })).resolves.toMatchObject({ code: 'unsafe_upload_host' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses an explicitly supplied public HTTPS URL without uploading or publishing the recording', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ output: { voice: `${model}-owned` } }), { status: 200 });
    });
    const { call } = handlers(fetchImpl);
    const publicUrl = 'https://voice.example.com/temporary/recording.wav?token=example';
    const result = await call('qwen-voice:create', { apiKey: 'bailian-key', preferredName: 'Mine', audio: wav10Seconds(), referenceUrl: publicUrl });
    expect(result).toMatchObject({ ok: true, voiceId: `${model}-owned` });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body).input.audio.data).toBe(publicUrl);
    expect(calls[0].url).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization');
  });

  it('rejects non-public reference URLs before contacting Alibaba', async () => {
    const fetchImpl = vi.fn();
    const { call } = handlers(fetchImpl);
    const result = await call('qwen-voice:create', {
      apiKey: 'key', audio: wav10Seconds(), referenceUrl: 'https://127.0.0.1/private.wav',
    });
    expect(result).toMatchObject({ code: 'invalid_reference_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deletes a LiveTranslate voice ID containing its model-version dots', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output: { status: 'ok' } }), { status: 200 }));
    const { call } = handlers(fetchImpl);
    const id = `${model}-my-voice-123`;
    await expect(call('qwen-voice:delete', { apiKey: 'key', voiceId: id })).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).input.voice).toBe(id);
  });
});
