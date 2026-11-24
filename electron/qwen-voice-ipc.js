const ENROLLMENT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
const UPLOAD_URL = 'https://dashscope.aliyuncs.com/api/v1/uploads';
const MODEL = 'qwen3.8-livetranslate-flash-realtime';
const MAX_AUDIO_BYTES = 10_000_000;
const MAX_JSON_BYTES = 64_000;

function qwenError(code, message, requestId) {
  return { ok: false, code, message, ...(requestId ? { requestId } : {}) };
}

function validWav(audio) {
  if (!(audio instanceof ArrayBuffer) || audio.byteLength < 44 || audio.byteLength >= MAX_AUDIO_BYTES) return false;
  const view = new DataView(audio);
  const text = (at, length) => String.fromCharCode(...new Uint8Array(audio, at, length));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || text(36, 4) !== 'data') return false;
  const dataBytes = view.getUint32(40, true);
  const duration = dataBytes / (24_000 * 2);
  return view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1
    && view.getUint32(24, true) === 24_000 && view.getUint16(34, true) === 16
    && dataBytes === audio.byteLength - 44 && duration >= 10 && duration <= 20;
}

function validPublicReferenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hostname || hostname.includes(':')) return false;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
    // Require a DNS name so callers cannot point Alibaba's fetcher at a literal
    // loopback, RFC1918, link-local, or metadata-service address.
    if (/^[0-9.]+$/.test(hostname)) return false;
    return true;
  } catch { return false; }
}

async function request(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { redirect: 'error', ...init, signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error('The request timed out. Please try again.'), { code: 'timeout' });
    throw Object.assign(new Error('Could not reach Alibaba Model Studio.'), { code: 'network' });
  } finally { clearTimeout(timeout); }
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw Object.assign(new Error('Alibaba returned an empty response.'), { code: 'empty_response' });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('Alibaba returned an unexpected response.'), { code: 'response_too_large' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw Object.assign(new Error(`Alibaba returned HTTP ${response.status}.`), { code: `http_${response.status}` }); }
  if (!response.ok || body.code) {
    const message = String(body.message ?? body.code ?? `HTTP ${response.status}`).slice(0, 400);
    throw Object.assign(new Error(message), { code: body.code ?? `http_${response.status}`, requestId: body.request_id });
  }
  return body;
}

async function createVoice(fetchImpl, apiKey, preferredName, audio, referenceUrl) {
  if (!validWav(audio)) return qwenError('invalid_audio', 'Use a clear 10–20 second mono WAV recording at 24 kHz.');
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 500) return qwenError('missing_key', 'Save a Bailian API key before creating a voice.');
  const prefix = String(preferredName ?? '').trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'MyVoice';
  try {
    let audioData;
    if (referenceUrl !== undefined && referenceUrl !== '') {
      if (!validPublicReferenceUrl(referenceUrl)) return qwenError('invalid_reference_url', 'Enter a public HTTPS audio URL without credentials or a fragment.');
      audioData = referenceUrl;
    } else {
      const policyResponse = await request(fetchImpl, `${UPLOAD_URL}?action=getPolicy&model=${encodeURIComponent(MODEL)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      }, 15_000);
      const policyBody = await responseJson(policyResponse);
      const policy = policyBody.data;
      if (!policy || typeof policy.upload_host !== 'string' || typeof policy.upload_dir !== 'string') {
        return qwenError('invalid_upload_policy', 'Alibaba returned an incomplete upload authorization.');
      }
      const host = new URL(policy.upload_host);
      if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash || !host.hostname.endsWith('.aliyuncs.com')) return qwenError('unsafe_upload_host', 'Alibaba returned an unsafe upload destination.');
      if (!/^[a-zA-Z0-9/_-]{1,512}$/.test(policy.upload_dir) || policy.upload_dir.includes('..')) return qwenError('invalid_upload_policy', 'Alibaba returned an invalid upload location.');
      if (!policy.policy || !policy.signature || !policy.oss_access_key_id) return qwenError('invalid_upload_policy', 'Alibaba returned an incomplete upload authorization.');
      const maxBytes = Number(policy.max_file_size_mb) * 1_000_000;
      if (Number.isFinite(maxBytes) && maxBytes > 0 && audio.byteLength > maxBytes) return qwenError('audio_too_large', 'The recording exceeds Alibaba’s upload limit.');

      const objectKey = `${policy.upload_dir}/sokuji-${require('crypto').randomUUID()}.wav`;
      const form = new FormData();
      form.append('OSSAccessKeyId', policy.oss_access_key_id);
      form.append('Signature', policy.signature);
      form.append('policy', policy.policy);
      form.append('x-oss-object-acl', policy.x_oss_object_acl || 'private');
      form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite || 'true');
      form.append('key', objectKey);
      form.append('success_action_status', '200');
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voice.wav');
      const upload = await request(fetchImpl, host.href, { method: 'POST', body: form }, 25_000);
      await upload.body?.cancel();
      if (!upload.ok) return qwenError(`upload_http_${upload.status}`, `Temporary audio upload failed (HTTP ${upload.status}).`);
      audioData = `oss://${objectKey}`;
    }

    const response = await request(fetchImpl, ENROLLMENT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-OssResourceResolve': 'enable',
      },
      body: JSON.stringify({ model: 'qwen-voice-enrollment', input: {
        action: 'create', target_model: MODEL, preferred_name: prefix, audio: { data: audioData },
      } }),
    }, 25_000);
    const body = await responseJson(response);
    const voiceId = body.output?.voice;
    if (typeof voiceId !== 'string' || !voiceId || voiceId.length > 256) return qwenError('missing_voice_id', 'Alibaba did not return a voice ID.', body.request_id);
    return { ok: true, voiceId, requestId: body.request_id };
  } catch (error) {
    const message = String(error?.message ?? 'The voice request failed.').replaceAll(apiKey, '[redacted]').slice(0, 500);
    return qwenError(error?.code ?? 'request_failed', message, error?.requestId);
  }
}

async function deleteVoice(fetchImpl, apiKey, voiceId) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 500) return qwenError('missing_key', 'Save a Bailian API key before deleting a voice.');
  if (typeof voiceId !== 'string' || voiceId.length > 256 || !/^[a-zA-Z0-9._-]+$/.test(voiceId)) return qwenError('invalid_voice_id', 'The voice ID is invalid.');
  try {
    const response = await request(fetchImpl, ENROLLMENT_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-voice-enrollment', input: { action: 'delete', voice: voiceId } }),
    }, 20_000);
    await responseJson(response);
    return { ok: true };
  } catch (error) {
    const message = String(error?.message ?? 'The voice request failed.').replaceAll(apiKey, '[redacted]').slice(0, 500);
    return qwenError(error?.code ?? 'request_failed', message, error?.requestId);
  }
}

function registerQwenVoiceIpc({ ipcMain, isTrustedSender, fetchImpl = fetch }) {
  ipcMain.handle('qwen-voice:create', async (event, args) => {
    if (!isTrustedSender(event.sender) || event.senderFrame !== event.sender.mainFrame) return qwenError('invalid_sender', 'This request is not available from this window.');
    if (!args || typeof args !== 'object') return qwenError('invalid_request', 'The voice request is invalid.');
    return createVoice(fetchImpl, args.apiKey, args.preferredName, args.audio, args.referenceUrl);
  });
  ipcMain.handle('qwen-voice:delete', async (event, args) => {
    if (!isTrustedSender(event.sender) || event.senderFrame !== event.sender.mainFrame) return qwenError('invalid_sender', 'This request is not available from this window.');
    if (!args || typeof args !== 'object') return qwenError('invalid_request', 'The voice request is invalid.');
    return deleteVoice(fetchImpl, args.apiKey, args.voiceId);
  });
}

module.exports = { registerQwenVoiceIpc, validWav, validPublicReferenceUrl, createVoice, deleteVoice };
