import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { startAgentControl, agentControlCommunicate } = require('./agent-control.js');
const isWindows = process.platform === 'win32';

function rawCall(pipe, request, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pipe });
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('raw call timed out')), timeoutMs);
    let done = false;
    function finish(error, response) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    }
    socket.once('error', (error) => finish(error));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, newline))); }
      catch (error) { finish(error); }
    });
  });
}

describe('agent control transport', () => {
  let profileDir;
  let endpoint;

  afterEach(async () => {
    if (endpoint) await endpoint.close();
    endpoint = undefined;
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
    profileDir = undefined;
  });

  it('requires Windows named pipes explicitly on other platforms', async () => {
    if (isWindows) return;
    await expect(startAgentControl({ profileDir: os.tmpdir(), dispatch: vi.fn() }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(agentControlCommunicate({ profileDir: os.tmpdir(), command: 'status' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });

  it.skipIf(!isWindows)('starts, dispatches an allowlisted call, and removes only its metadata on close', async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'sokuji-agent-control-'));
    const dispatch = vi.fn(async (command, args) => ({ ok: true, data: { command, args } }));
    endpoint = await startAgentControl({ profileDir, dispatch });
    const metadata = JSON.parse(await readFile(path.join(profileDir, 'agent-control.json'), 'utf8'));
    expect(metadata).toMatchObject({ version: 1, pid: process.pid });
    expect(metadata.pipe).toMatch(/^\\\\\.\\pipe\\sokuji-agent-[a-f0-9]{32}$/);
    expect(metadata.token).toMatch(/^[a-f0-9]{64}$/);

    await expect(agentControlCommunicate({ profileDir, command: 'status' }))
      .resolves.toEqual({ ok: true, data: { command: 'status', args: {} } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith('status', {});
    await endpoint.close();
    endpoint = undefined;
    await expect(readFile(path.join(profileDir, 'agent-control.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!isWindows)('rejects bad auth, unknown fields, commands, and invalid args without dispatch', async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'sokuji-agent-control-'));
    const dispatch = vi.fn(async () => ({ ok: true, data: {} }));
    endpoint = await startAgentControl({ profileDir, dispatch });
    const { pipe, token } = JSON.parse(await readFile(path.join(profileDir, 'agent-control.json'), 'utf8'));

    await expect(rawCall(pipe, { token: 'not-the-token', command: 'status', args: {} }))
      .resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    await expect(rawCall(pipe, { token, command: 'arbitrary.exec', args: {} }))
      .resolves.toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } });
    await expect(rawCall(pipe, { token, command: 'status', args: {}, extra: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    await expect(rawCall(pipe, { token, command: 'logs.enable', args: { enabled: false } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    await expect(rawCall(pipe, { token, command: 'logs.list', args: { limit: 0 } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    await expect(rawCall(pipe, { token, command: 'session.start', args: { arbitrary: 'value' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    await expect(rawCall(pipe, { token, command: 'usage.summary', args: { month: '2026-13' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.skipIf(!isWindows)('normalizes the documented logs and captions query arguments', async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'sokuji-agent-control-'));
    const dispatch = vi.fn(async (command, args) => ({ ok: true, data: { command, args } }));
    endpoint = await startAgentControl({ profileDir, dispatch });

    await expect(agentControlCommunicate({ profileDir, command: 'logs.enable' }))
      .resolves.toEqual({ ok: true, data: { command: 'logs.enable', args: {} } });
    await expect(agentControlCommunicate({ profileDir, command: 'logs.list' }))
      .resolves.toEqual({ ok: true, data: { command: 'logs.list', args: { limit: 20 } } });
    await expect(agentControlCommunicate({ profileDir, command: 'captions.list' }))
      .resolves.toEqual({ ok: true, data: { command: 'captions.list', args: { limit: 20, includeText: false } } });
    await expect(agentControlCommunicate({ profileDir, command: 'captions.list', args: { limit: 200, includeText: true } }))
      .resolves.toEqual({ ok: true, data: { command: 'captions.list', args: { limit: 100, includeText: true } } });
    await expect(agentControlCommunicate({ profileDir, command: 'usage.summary', args: { month: '2026-11' } }))
      .resolves.toEqual({ ok: true, data: { command: 'usage.summary', args: { month: '2026-11' } } });
  });

  it.skipIf(!isWindows)('allows one credential only for the explicit Bailian configuration command', async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'sokuji-agent-control-'));
    const dispatch = vi.fn(async () => ({ ok: true, data: { provider: 'qwen_livetranslate' } }));
    endpoint = await startAgentControl({ profileDir, dispatch });
    const apiKey = 'sk-ws-local-test-placeholder-123';
    const command = 'provider.configure-qwen-beijing';

    await expect(agentControlCommunicate({ profileDir, command, args: { apiKey, host: 'other.example' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(dispatch).not.toHaveBeenCalled();

    const response = await agentControlCommunicate({ profileDir, command, args: { apiKey } });
    expect(response).toEqual({ ok: true, data: { provider: 'qwen_livetranslate' } });
    expect(dispatch).toHaveBeenCalledWith(command, { apiKey });
    expect(JSON.stringify(response)).not.toContain(apiKey);
  });

  it.skipIf(!isWindows)('accepts a workspace ID and its key only on the workspace command', async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'sokuji-agent-control-'));
    const dispatch = vi.fn(async () => ({ ok: true, data: { configured: true } }));
    endpoint = await startAgentControl({ profileDir, dispatch });
    const command = 'provider.configure-qwen-workspace';
    const apiKey = 'sk-ws-test-placeholder+/valid=';
    const workspaceId = 'llm-testcompany';

    for (const bad of ['https://llm-testcompany', 'llm-testcompany.cn-beijing.maas.aliyuncs.com', 'llm-company/workspace']) {
      await expect(agentControlCommunicate({ profileDir, command, args: { apiKey, workspaceId: bad } }))
        .resolves.toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    }
    expect(dispatch).not.toHaveBeenCalled();
    await expect(agentControlCommunicate({ profileDir, command, args: { apiKey, workspaceId } }))
      .resolves.toEqual({ ok: true, data: { configured: true } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(command, { apiKey, workspaceId });
  });

  it.skipIf(!isWindows)('does not overwrite an active endpoint metadata file', async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'sokuji-agent-control-'));
    const file = path.join(profileDir, 'agent-control.json');
    const original = JSON.stringify({ version: 1, pipe: '\\\\.\\pipe\\sokuji-agent-existing', token: 'x'.repeat(64), pid: process.pid });
    await writeFile(file, original, { encoding: 'utf8', mode: 0o600 });
    await expect(startAgentControl({ profileDir, dispatch: vi.fn() }))
      .rejects.toMatchObject({ code: 'AGENT_CONTROL_ALREADY_ACTIVE' });
    await expect(readFile(file, 'utf8')).resolves.toBe(original);
  });

  it('bounds client timeout values', async () => {
    await expect(agentControlCommunicate({ profileDir: 'unused', command: 'status', timeoutMs: 60_001 }))
      .rejects.toMatchObject({ name: 'RangeError' });
  });
});
