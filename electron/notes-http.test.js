import { describe, expect, it, vi } from 'vitest';
import { notesEndpointOf } from '../src/lib/notes/notesEndpoint';
import { createNotesHttp } from './notes-http.js';

const id = '9bbde737-2b96-48f1-b646-32aee970f07a';
const url = 'http://127.0.0.1:8000/v1/chat/completions';
const body = '{"model":"local-model"}';

describe('desktop compatible notes', () => {
  it('normalizes base URLs and accepts cleartext private addresses only', () => {
    expect(notesEndpointOf('http://192.168.0.5:8000/v1/')).toBe('http://192.168.0.5:8000/v1/chat/completions');
    expect(notesEndpointOf(url)).toBe(url);
    expect(notesEndpointOf('https://model.example/v1')).toBe('https://model.example/v1/chat/completions');
    expect(notesEndpointOf('http://model.example/v1')).toBeNull();
    expect(notesEndpointOf('https://key@model.example/v1')).toBeNull();
    expect(notesEndpointOf('https://model.example/v1?token=secret')).toBeNull();
  });

  it('uses only the configured API key and forbids redirects', async () => {
    const send = vi.fn().mockImplementation(async () => new Response('{"choices":[]}', { headers: { 'x-request-id': 'notes-1' } }));
    const http = createNotesHttp(send);
    await expect(http.complete(7, { id, url, body })).resolves.toEqual({ ok: true, status: 200, body: '{"choices":[]}', requestId: 'notes-1' });
    expect(send).toHaveBeenLastCalledWith(url, expect.objectContaining({
      method: 'POST', body, redirect: 'error', headers: { 'Content-Type': 'application/json' },
    }));
    await http.complete(7, { id, url, body, authorization: 'Bearer fixture-key' });
    expect(send).toHaveBeenLastCalledWith(url, expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-key' },
    }));
    await expect(http.complete(7, { id, url: 'file:///private', body })).resolves.toEqual({ ok: false, code: 'invalid' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('cancels only the page’s own request', async () => {
    let signal;
    const http = createNotesHttp((_, options) => {
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const pending = http.complete(7, { id, url, body });
    http.abort(9, { id });
    expect(signal.aborted).toBe(false);
    http.abort(7, { id });
    await expect(pending).resolves.toEqual({ ok: false, code: 'transport' });
  });
});
