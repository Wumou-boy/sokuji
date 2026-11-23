'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const CONTROL_FILE = 'agent-control.json';
const PIPE_PREFIX = '\\\\.\\pipe\\sokuji-agent-';
const VERSION = 1;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_FRAME_IDLE_MS = 3_000;
const DISPATCH_TIMEOUT_MS = 40_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 45_000;
const MAX_CLIENT_TIMEOUT_MS = 60_000;
const COMMANDS = new Set([
  'status', 'session.start', 'session.stop', 'logs.enable', 'logs.list', 'captions.list',
  'provider.configure-qwen-beijing', 'credentials.status', 'notes.check',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function ownKeysOnly(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeArgs(command, args) {
  if (args === undefined) args = {};
  if (!isPlainObject(args)) return { error: failure('BAD_ARGS', 'Command arguments must be an object.') };
  if (command === 'notes.check') {
    if (!ownKeysOnly(args, ['service']) || !['bailian_notes', 'compatible_notes'].includes(args.service)) {
      return { error: failure('BAD_ARGS', 'Choose Bailian or the configured compatible notes service.') };
    }
    return { args: { service: args.service } };
  }
  if (command === 'provider.configure-qwen-beijing') {
    if (!ownKeysOnly(args, ['apiKey']) || typeof args.apiKey !== 'string' || !/^sk-[A-Za-z0-9._-]{20,250}$/.test(args.apiKey)) {
      return { error: failure('BAD_ARGS', 'Supply a valid Bailian API key on standard input.') };
    }
    return { args: { apiKey: args.apiKey } };
  }

  if (command === 'logs.enable') {
    if (Object.keys(args).length !== 0) {
      return { error: failure('BAD_ARGS', 'logs.enable does not accept arguments.') };
    }
    return { args: {} };
  }
  if (command === 'logs.list') {
    if (!ownKeysOnly(args, ['limit']) || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1))) {
      return { error: failure('BAD_ARGS', 'logs.list accepts only a positive integer limit.') };
    }
    return { args: { limit: Math.min(args.limit ?? 20, 100) } };
  }
  if (command === 'captions.list') {
    if (!ownKeysOnly(args, ['limit', 'includeText'])
      || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1))
      || (args.includeText !== undefined && typeof args.includeText !== 'boolean')) {
      return { error: failure('BAD_ARGS', 'captions.list accepts only a positive integer limit and boolean includeText.') };
    }
    if (args.limit === undefined) return { args: { limit: 20, includeText: args.includeText ?? false } };
    return { args: { limit: Math.min(args.limit, 100), includeText: args.includeText ?? false } };
  }
  if (Object.keys(args).length !== 0) return { error: failure('BAD_ARGS', `${command} does not accept arguments.`) };
  return { args: {} };
}

function parseRequest(line, expectedToken) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return { error: failure('BAD_JSON', 'Request was not valid JSON.') };
  }
  if (!ownKeysOnly(request, ['token', 'command', 'args'])
    || typeof request.token !== 'string'
    || typeof request.command !== 'string') {
    return { error: failure('BAD_REQUEST', 'Request must contain only token, command, and args fields.') };
  }
  const supplied = Buffer.from(request.token, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { error: failure('UNAUTHORIZED', 'Agent-control token was not accepted.') };
  }
  if (!COMMANDS.has(request.command)) return { error: failure('UNKNOWN_COMMAND', 'Command is not allowed.') };
  const normalized = normalizeArgs(request.command, request.args);
  if (normalized.error) return normalized;
  return { command: request.command, args: normalized.args };
}

function normalizeDispatchResult(value) {
  if (isPlainObject(value) && value.ok === true && Object.hasOwn(value, 'data')) {
    return { ok: true, data: value.data };
  }
  if (isPlainObject(value) && value.ok === false && isPlainObject(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
    return {
      ok: false,
      error: {
        code: value.error.code.slice(0, 64),
        message: value.error.message.replace(/[\r\n\0]/g, ' ').slice(0, 240),
      },
    };
  }
  return failure('BAD_DISPATCH_RESPONSE', 'Application returned an invalid command response.');
}

function encodeResponse(response) {
  let encoded;
  try {
    encoded = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
  } catch {
    encoded = Buffer.from(`${JSON.stringify(failure('BAD_DISPATCH_RESPONSE', 'Application response could not be encoded.'))}\n`, 'utf8');
  }
  if (encoded.length > MAX_RESPONSE_BYTES) {
    return Buffer.from(`${JSON.stringify(failure('RESPONSE_TOO_LARGE', 'Application response exceeded the size limit.'))}\n`, 'utf8');
  }
  return encoded;
}

function timeoutResult(promise, ms, code, message) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(failure(code, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pipePath() {
  return `${PIPE_PREFIX}${randomBytes(16).toString('hex')}`;
}

async function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    // EPERM, access-denied, and unknown errors fail closed: do not remove a
    // control file unless this process can establish that its owner is gone.
    return true;
  }
}

async function removeStaleControlFile(profileDir) {
  const file = path.join(profileDir, CONTROL_FILE);
  let contents;
  try {
    contents = await fs.readFile(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  let previous;
  try {
    previous = JSON.parse(contents.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Existing agent-control metadata cannot be verified.'), { code: 'AGENT_CONTROL_METADATA_INVALID' });
  }
  if (!isPlainObject(previous) || !Number.isInteger(previous.pid) || previous.pid < 1) {
    throw Object.assign(new Error('Existing agent-control metadata cannot be verified.'), { code: 'AGENT_CONTROL_METADATA_INVALID' });
  }
  if (await pidIsAlive(previous.pid)) {
    throw Object.assign(new Error('Another agent-control endpoint may still be active.'), { code: 'AGENT_CONTROL_ALREADY_ACTIVE' });
  }
  const current = await fs.readFile(file).catch((error) => error && error.code === 'ENOENT' ? null : Promise.reject(error));
  if (current && current.equals(contents)) await fs.unlink(file);
  else if (current) throw Object.assign(new Error('Agent-control metadata changed during startup.'), { code: 'AGENT_CONTROL_RACE' });
}

function responseError(socket, response) {
  if (!socket.destroyed) socket.end(encodeResponse(response));
}

/** Starts the Windows-only named-pipe command endpoint and publishes its per-run capability in profileDir. */
async function startAgentControl({ profileDir, dispatch } = {}) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('Agent control currently requires Windows named pipes.'), { code: 'UNSUPPORTED_PLATFORM' });
  }
  if (typeof profileDir !== 'string' || profileDir.length === 0 || typeof dispatch !== 'function') {
    throw new TypeError('startAgentControl requires profileDir and dispatch.');
  }

  await fs.mkdir(profileDir, { recursive: true });
  await removeStaleControlFile(profileDir);
  const endpoint = pipePath();
  const token = randomBytes(32).toString('hex');
  const controlFile = path.join(profileDir, CONTROL_FILE);
  const clients = new Set();
  let closing;
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(REQUEST_FRAME_IDLE_MS, () => responseError(socket, failure('REQUEST_TIMEOUT', 'Request frame timed out.')));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled || socket.destroyed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        responseError(socket, failure('REQUEST_TOO_LARGE', 'Request exceeded the size limit.'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      if (newline !== buffer.length - 1) {
        responseError(socket, failure('BAD_FRAME', 'Only one newline-delimited request is allowed per connection.'));
        return;
      }
      let line = buffer.subarray(0, newline);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      const request = parseRequest(line.toString('utf8'), token);
      if (request.error) {
        responseError(socket, request.error);
        return;
      }
      const result = Promise.resolve().then(() => dispatch(request.command, request.args)).then(normalizeDispatchResult, () => failure('COMMAND_FAILED', 'Application command failed.'));
      void timeoutResult(result, DISPATCH_TIMEOUT_MS, 'COMMAND_TIMEOUT', 'Application command timed out.')
        .then((response) => responseError(socket, response));
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
  // A post-listen pipe error must not become an unhandled EventEmitter error.
  server.on('error', () => {});

  const metadata = { version: VERSION, pipe: endpoint, token, pid: process.pid };
  try {
    // Windows inherits the profile directory's ACL; mode 0600 also narrows the
    // file on POSIX-compatible environments and documents the intended scope.
    await fs.writeFile(controlFile, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    close() {
      if (closing) return closing;
      closing = (async () => {
        for (const client of clients) client.destroy();
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        const current = await fs.readFile(controlFile).catch((error) => error && error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!current) return;
        try {
          const stored = JSON.parse(current.toString('utf8'));
          if (stored && stored.pipe === endpoint && stored.token === token) await fs.unlink(controlFile);
        } catch { /* Do not delete metadata that can no longer be proven to belong to this endpoint. */ }
      })();
      return closing;
    },
  };
}

async function agentControlCommunicate({ profileDir, command, args = {}, timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('Agent control currently requires Windows named pipes.'), { code: 'UNSUPPORTED_PLATFORM' });
  }
  if (typeof profileDir !== 'string' || profileDir.length === 0 || !COMMANDS.has(command)) {
    throw new TypeError('profileDir and an allowlisted command are required.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CLIENT_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_CLIENT_TIMEOUT_MS}.`);
  }
  const normalized = normalizeArgs(command, args);
  if (normalized.error) return normalized.error;
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(profileDir, CONTROL_FILE), 'utf8'));
  } catch {
    throw Object.assign(new Error('Sokuji agent-control endpoint is unavailable.'), { code: 'AGENT_CONTROL_UNAVAILABLE' });
  }
  if (!isPlainObject(metadata) || metadata.version !== VERSION || typeof metadata.pipe !== 'string'
    || !metadata.pipe.startsWith(PIPE_PREFIX) || !/^[a-f0-9]{64}$/.test(metadata.token ?? '')) {
    throw Object.assign(new Error('Sokuji agent-control metadata is invalid.'), { code: 'AGENT_CONTROL_METADATA_INVALID' });
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: metadata.pipe });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Sokuji agent-control request timed out.'), { code: 'AGENT_CONTROL_TIMEOUT' })), timeoutMs);
    socket.setNoDelay(true);
    socket.on('error', () => finish(Object.assign(new Error('Sokuji agent-control endpoint could not be reached.'), { code: 'AGENT_CONTROL_UNAVAILABLE' })));
    socket.on('connect', () => {
      const frame = Buffer.from(`${JSON.stringify({ token: metadata.token, command, args: normalized.args })}\n`, 'utf8');
      if (frame.length > MAX_REQUEST_BYTES) {
        finish(Object.assign(new Error('Agent-control request exceeded the size limit.'), { code: 'REQUEST_TOO_LARGE' }));
        return;
      }
      socket.write(frame);
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(Object.assign(new Error('Sokuji agent-control response exceeded the size limit.'), { code: 'RESPONSE_TOO_LARGE' }));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        finish(Object.assign(new Error('Sokuji agent-control response frame was invalid.'), { code: 'BAD_FRAME' }));
        return;
      }
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (isPlainObject(response) && response.ok === true && Object.hasOwn(response, 'data')) finish(null, response);
        else if (isPlainObject(response) && response.ok === false && isPlainObject(response.error)
          && typeof response.error.code === 'string' && typeof response.error.message === 'string') finish(null, response);
        else finish(Object.assign(new Error('Sokuji agent-control response was invalid.'), { code: 'BAD_RESPONSE' }));
      } catch {
        finish(Object.assign(new Error('Sokuji agent-control response was invalid JSON.'), { code: 'BAD_JSON' }));
      }
    });
  });
}

module.exports = { startAgentControl, agentControlCommunicate };
