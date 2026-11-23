// src/lib/notes/chat.ts
//
// The notes model is asked through a chat port: a system prompt, the user's part as compact JSON, and a JSON object
// back. Two ports: the user's own key with a text model (`textModelChat.ts`: OpenAI, Gemini, a compatible service,
// over the shared text-model client), and Kizuna AI's relay (`relayChat.ts`, which sends the body made here). A rate
// limit is waited out the way the measuring scripts did (15 s, then 30, 45, 60); anything else the service refuses
// comes back as a ChatError carrying the service's own message, for the user to read.

import { realClock, type Clock } from '../contract/clock';
import { refusesNone, takesReasoningEffort } from '../textModel/reasoning';

/** Which models take a `reasoning_effort`: GPT-5.1 and later; any other model is sent none, and a refusal is not retried. */
export { takesReasoningEffort };

export type ChatEffort = 'none' | 'low' | 'medium';

/** Which prompt a call is: the relay puts in its own copy of it by this name and version. */
/** What one answer used, as OpenAI reports it (`usage`). */
export interface NotesUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export type NotesPromptName = 'live-update' | 'whole-meeting' | 'meeting-part' | 'combine-parts' | 'check-names';

export interface ChatRequest {
  system: string;
  prompt: NotesPromptName;
  promptVersion: number;
  user: unknown;
  effort: ChatEffort;
  maxTokens: number;
  signal: AbortSignal;
  /** Each answer the service gave, with its request id when it names one (a hosted relay bills by these). */
  onAnswered?(info: { requestId?: string; usage?: NotesUsage }): void;
}

/** Resolves to the model's answer, parsed: always a JSON object. */
export type ChatPort = (r: ChatRequest) => Promise<unknown>;

/** Refusals another try cannot fix: a bad request, a wrong or missing key, no access, no such model. */
const FINAL_STATUSES = new Set([400, 401, 403, 404]);

export class ChatError extends Error {
  readonly status?: number;
  readonly serviceMessage?: string;
  /** The program's own reason when the service gave none: `not-json`, `no-answer`, `no-topics`. */
  readonly code?: string;
  /** Whether trying again can help. */
  readonly retryable: boolean;

  constructor(message: string, o: { status?: number; serviceMessage?: string; code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ChatError';
    this.status = o.status;
    this.serviceMessage = o.serviceMessage;
    this.code = o.code;
    this.retryable = o.retryable ?? !(o.status !== undefined && FINAL_STATUSES.has(o.status));
  }
}

/** A rate limit is waited out at most this many times (15 s longer each time with the user's own key). */
export const RATE_LIMIT_WAITS = 4;
const RATE_LIMIT_WAIT_MS = 15_000;

export const abortError = () => new DOMException('The notes request was cancelled', 'AbortError');

/** Waits `ms` on `clock` (the real one unless told), or rejects as cancelled when `signal` aborts first. */
export const wait = (ms: number, signal: AbortSignal, clock: Pick<Clock, 'setTimeout'> = realClock) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      cancel();
      reject(abortError());
    };
    const cancel = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** The service's own words about a refusal, and its error code or type. */
export const refusalOf = async (response: Response): Promise<{ message?: string; code?: string }> => {
  try {
    const error = ((await response.json()) as { error?: { message?: unknown; code?: unknown; type?: unknown } })?.error;
    const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : undefined;
    return { message: typeof error?.message === 'string' ? error.message : undefined, code };
  } catch {
    return {};
  }
};

/** The `reasoning_effort` sent to `model` for `effort`, or null for none (the rule is the text-model client's). */
function effortFor(model: string, effort: ChatEffort): ChatEffort | null {
  if (!takesReasoningEffort(model)) return null;
  return effort === 'none' && refusesNone(model) ? 'low' : effort;
}

/** The request body for `model` through Kizuna AI's relay (an own key's notes send the same members, `textModel/notes.ts`). */
export function chatBody(model: string, r: Pick<ChatRequest, 'system' | 'user' | 'effort' | 'maxTokens'>): string {
  const reasoning = effortFor(model, r.effort);
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: JSON.stringify(r.user) },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: r.maxTokens,
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
  });
}

async function parseAnswer(response: Response, allowFence: boolean): Promise<object> {
  let content: unknown;
  try {
    content = ((await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  } catch {
    content = undefined;
  }
  if (typeof content !== 'string') throw new ChatError('The notes model gave no answer', { code: 'no-answer' });
  const fenced = allowFence ? content.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i) : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    throw new ChatError('The notes model answered with something other than JSON', { code: 'not-json' });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ChatError('The notes model answered with something other than a JSON object', { code: 'not-json' });
  }
  return parsed;
}
/** The model's answer from a chat completion response: always a JSON object, or a ChatError. */
export function answerOf(response: Response): Promise<object> {
  return parseAnswer(response, false);
}

export interface CompatibleChatOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Use Bailian's non-thinking mode for the short periodic updates. */
  bailian?: boolean;
  fetch?: typeof fetch;
}

/** OpenAI-compatible Chat Completions for endpoints that do not support OpenAI-specific body fields. */
export function compatibleChat(o: CompatibleChatOptions): ChatPort {
  return completions(o, (r) => JSON.stringify({
    model: o.model,
    messages: [{ role: 'system', content: r.system }, { role: 'user', content: JSON.stringify(r.user) }],
    max_tokens: r.maxTokens,
    ...(o.bailian ? { enable_thinking: false } : {}),
  }), true);
}

export function openAiChat(o: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch }): ChatPort {
  return completions(o, (r) => chatBody(o.model, r), false);
}

function completions(
  o: Pick<CompatibleChatOptions, 'baseUrl' | 'apiKey' | 'fetch'>,
  bodyFor: (r: ChatRequest) => string,
  allowFence: boolean,
): ChatPort {
  const send = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) };

  return async (r) => {
    const { signal, onAnswered } = r;
    const body = bodyFor(r);
    for (let waited = 0; ; ) {
      const response = await send(url, {
        method: 'POST',
        headers,
        body,
        signal,
      });
      const requestId = response.headers.get('x-request-id');
      onAnswered?.(requestId ? { requestId } : {});
      if (!response.ok) {
        const refusal = await refusalOf(response);
        // Out of credit also comes as 429, and no wait helps it.
        const noCredit = refusal.code === 'insufficient_quota';
        if (response.status === 429 && !noCredit && waited < RATE_LIMIT_WAITS) {
          waited += 1;
          await wait(RATE_LIMIT_WAIT_MS * waited, signal);
          continue;
        }
        throw new ChatError(`The notes model refused the request (${response.status})`, {
          status: response.status,
          serviceMessage: o.apiKey ? refusal.message?.split(o.apiKey).join('[redacted]') : refusal.message,
          ...(noCredit ? { retryable: false } : {}),
        });
      }
      return parseAnswer(response, allowFence);
    }
  };
}
