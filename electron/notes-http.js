'use strict';

const { notesEndpointOf } = require('../src/lib/notes/notesEndpoint.ts');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const NOTES_TIMEOUT_MS = 120_000;

function requestIdOf(args) {
  return typeof args?.id === 'string' && /^[a-f0-9-]{36}$/.test(args.id) ? args.id : null;
}

async function readAnswer(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('The notes response was too large.');
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function createNotesHttp(send = globalThis.fetch) {
  const pending = new Map();

  async function complete(owner, args) {
    const id = requestIdOf(args);
    const url = typeof args?.url === 'string' ? notesEndpointOf(args.url) : null;
    const authorization = args?.authorization;
    if (!id || !url || url !== args.url || typeof args.body !== 'string'
        || Buffer.byteLength(args.body) > MAX_BODY_BYTES
        || (authorization !== undefined && (typeof authorization !== 'string' || !/^Bearer [\x21-\x7e]{1,4096}$/.test(authorization)))) {
      return { ok: false, code: 'invalid' };
    }
    const key = `${owner}:${id}`;
    if (pending.has(key)) return { ok: false, code: 'busy' };
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(NOTES_TIMEOUT_MS);
    pending.set(key, controller);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authorization) headers.Authorization = authorization;
      const response = await send(url, {
        method: 'POST', headers, body: args.body, redirect: 'error',
        signal: AbortSignal.any([controller.signal, deadline]),
      });
      const body = await readAnswer(response);
      const requestId = response.headers.get('x-request-id');
      return { ok: true, status: response.status, body, ...(requestId ? { requestId } : {}) };
    } catch {
      return { ok: false, code: deadline.aborted ? 'timeout' : 'transport' };
    } finally {
      pending.delete(key);
    }
  }

  function abort(owner, args) {
    const id = requestIdOf(args);
    if (id) pending.get(`${owner}:${id}`)?.abort();
  }

  return { complete, abort };
}

module.exports = { createNotesHttp };
