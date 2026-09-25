/**
 * THE OpenRouter transport seam (ported, trimmed, from Campaigner
 * `src/llm/openrouter.ts`). Every request to OpenRouter goes through
 * `fetchWithRetries` — the ONLY network call in `src/` (pinned by
 * `tests/architecture/one-fetch.test.ts`). Chat streaming is not ported yet.
 */
import type { z } from 'zod';

import { OpenRouterError, errorTypeFromBody } from '@/llm/errors';

/** The OpenRouter API root. */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** 429/5xx are retried twice with backoff (jittered 2s / 8s). */
export const DEFAULT_RETRY_BACKOFFS_MS: readonly number[] = [2_000, 8_000];

/** A request whose response headers never arrive is aborted loudly. */
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

/**
 * A request that must RENDER an image before it can answer returns its headers
 * only once the image is ready — the Images API (`POST /images`) and the chat
 * path with image output (`POST /chat/completions`) both take it. The value
 * lives here, in the transport seam, so the two paths cannot drift.
 */
export const IMAGE_RENDER_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;

/** Upper bound for an honored Retry-After hint. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Shared headers. An empty key sends no Authorization (public endpoints). */
export function openRouterHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Title': 'Imager',
  };
  if (apiKey !== '') headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Retry-After header → milliseconds (seconds or HTTP-date form), capped. */
export function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return null;
}

function jitter(ms: number): number {
  return ms * 0.75 + Math.random() * ms * 0.5;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

async function fetchWithHeadersTimeout(
  url: string,
  init: RequestInit,
  headersTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `OpenRouter request timed out: no response headers within ${String(Math.round(headersTimeoutMs / 1000))}s — check your connection and retry`,
        'TimeoutError',
      ),
    );
  }, headersTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * One OpenRouter request. `path` is relative to OPENROUTER_BASE. Non-OK
 * responses throw a typed OpenRouterError carrying the body and its
 * `metadata.error_type`; 429/5xx are retried per `backoffs`.
 */
export async function fetchWithRetries(
  path: string,
  init: RequestInit,
  backoffs: readonly number[] = DEFAULT_RETRY_BACKOFFS_MS,
  headersTimeoutMs: number = DEFAULT_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const url = `${OPENROUTER_BASE}${path}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithHeadersTimeout(url, init, headersTimeoutMs);
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    const backoff = backoffs[attempt];
    if (!retryable || backoff === undefined) {
      const bodyText = await response.text();
      throw new OpenRouterError('http', response.status, bodyText, errorTypeFromBody(bodyText));
    }
    const hint = response.status === 429 ? retryAfterMs(response) : null;
    await sleep(hint ?? jitter(backoff), init.signal ?? undefined);
  }
}

/** Reads a 200 body as JSON and validates it; ANY failure is a loud
 * OpenRouterError('invalid-response'), never an empty result (rule 1/3). */
export async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new OpenRouterError(
      'invalid-response',
      response.status,
      `body is not JSON (${String(error)})`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new OpenRouterError(
      'invalid-response',
      response.status,
      `response failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
