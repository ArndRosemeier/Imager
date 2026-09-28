/**
 * THE ServerStore transport seam (docs/17 row 42): the ONE place the app talks
 * to `store.futuremagic.de`.
 *
 * WHY A SECOND TRANSPORT AND NOT THE OPENROUTER ONE: the two services share
 * nothing but the word "fetch". OpenRouter's seam (`src/llm/client.ts`) owns a
 * JSON API with an OpenRouter error envelope, `X-Title` branding and 429/5xx
 * retries; this one owns opaque bytes, a documented `{error:{code,message}}`
 * envelope, a Bearer key and `Retry-After` on 429. Folding them into one
 * function would mean one call site branching on which service it is talking
 * to. Instead: TWO named fetch seams, each pinned to exactly one file
 * (`tests/architecture/one-fetch.test.ts`).
 *
 * NO RETRY HERE, deliberately: the service rate limits per client (600/min) and
 * answers `429 rate_limited` with `Retry-After`, which this seam reports to the
 * user rather than hiding behind a backoff loop — a write that silently
 * retried could double-upload. A 5xx is reported; a transport failure (offline,
 * DNS, CORS, timeout) is reported. Nothing is swallowed (rules 1/2).
 *
 * The key is a credential: it is sent in `Authorization` ONLY — never a query
 * string, never a URL, never logged, never put in an error message (the error
 * text names codes and paths, never the header value).
 */
import { z } from 'zod';

import {
  ServerStoreError,
  errorFromResponse,
  type ServerStoreErrorCode,
} from '@/server/store-errors';

/** The documented production origin; the stored setting may point elsewhere. */
export const DEFAULT_BASE_URL = 'https://store.futuremagic.de';

/** The store every Imager object lives in. The app never creates stores — that
 * needs a master admin key this app must never hold. */
export const DEFAULT_STORE_NAME = 'imager';

/** A request whose response headers never arrive is aborted loudly (same
 * discipline as the OpenRouter seam's headers timeout). */
export const HEADERS_TIMEOUT_MS = 60_000;

/** One object-row of a listing, exactly as `GET …/objects` documents it. */
export const objectEntrySchema = z.strictObject({
  store: z.string(),
  name: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ObjectEntry = z.infer<typeof objectEntrySchema>;

const listResponseSchema = z.object({ objects: z.array(objectEntrySchema) });
const whoamiSchema = z.object({
  id: z.string(),
  label: z.string(),
  stores: z.array(z.string()),
  perms: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type WhoAmI = z.infer<typeof whoamiSchema>;

const putResponseSchema = z.object({
  store: z.string(),
  name: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type PutResult = z.infer<typeof putResponseSchema>;

/** What one object read produced. `sha256` is the service's own header. */
export interface ObjectBytes {
  bytes: Uint8Array<ArrayBuffer>;
  /** `x-serverstore-sha256` — CORS-exposed, so the browser can read it. */
  sha256: string;
  /**
   * The service's own `content-type` (`application/octet-stream` by contract).
   * It is NOT the picture's MIME type — this app's object format carries that
   * in its JSON header — so it is reported for diagnostics only.
   */
  contentType: string;
}

/** The caller's ServerStore target: an origin, a store name and a key. */
export interface StoreTarget {
  baseUrl: string;
  store: string;
  /** The `ssk_…` credential. Never formatted into a message or a URL. */
  key: string;
}

/** `https://host` → `https://host/` (so path joins cannot drop a segment). */
function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new ServerStoreError('transport', 'No ServerStore URL is configured.');
  return trimmed;
}

function storePath(target: StoreTarget, suffix: string): string {
  return `/stores/${encodeURIComponent(target.store)}${suffix}`;
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * ONE request. `init.json` is serialised here; everything else is the caller's.
 * A non-OK response becomes a typed `ServerStoreError`; a URL-level failure
 * becomes a `transport` error naming the curl-able path (never the key).
 */
export async function requestRaw(
  target: StoreTarget,
  path: string,
  init: { method: string; body?: Uint8Array<ArrayBuffer>; json?: unknown; signal?: AbortSignal },
): Promise<Response> {
  const base = normalizeBase(target.baseUrl);
  const headers: Record<string, string> = { Authorization: `Bearer ${target.key}` };
  const requestInit: RequestInit = { method: init.method, headers };
  if (init.signal !== undefined) requestInit.signal = init.signal;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(init.json);
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    requestInit.body = init.body;
  }

  const controller = new AbortController();
  const callerSignal = init.signal;
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
        `ServerStore request timed out: no response headers within ${String(Math.round(HEADERS_TIMEOUT_MS / 1000))}s for ${init.method} ${path}`,
        'TimeoutError',
      ),
    );
  }, HEADERS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...requestInit, signal: controller.signal });
  } catch (error: unknown) {
    // A URL-level failure has NO envelope: report the method and path, never
    // the key, and keep the underlying reason (rule 1).
    throw new ServerStoreError(
      'transport',
      `Could not reach ServerStore at ${base} (${init.method} ${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

  if (!response.ok) {
    throw errorFromResponse(response, await readText(response));
  }
  return response;
}

/** Parse a JSON body with zod; a mismatch is a loud `invalid-response`. */
async function readJson<T>(response: Response, schema: z.ZodType<T>, path: string): Promise<T> {
  const text = await readText(response);
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ServerStoreError(
      'invalid-response',
      `ServerStore answered ${path} with a body that is not JSON (${String(error)}).`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ServerStoreError(
      'invalid-response',
      `ServerStore answered ${path} with a body this app does not understand: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** `GET /whoami` — which key, which scope. The app shows this on connect. */
export async function whoami(target: StoreTarget, signal?: AbortSignal): Promise<WhoAmI> {
  const response = await requestRaw(target, '/whoami', {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  return readJson(response, whoamiSchema, '/whoami');
}

/** `GET /healthz` — no key required. Used by the store panel's reachability check. */
export async function healthz(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const base = normalizeBase(baseUrl);
  let response: Response;
  try {
    response = await fetch(`${base}/healthz`, signal === undefined ? {} : { signal });
  } catch (error: unknown) {
    throw new ServerStoreError(
      'transport',
      `Could not reach ServerStore at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) throw errorFromResponse(response, await readText(response));
  const body = await readJson(response, z.object({ ok: z.boolean() }), '/healthz');
  return body.ok;
}

/**
 * `GET /stores/{store}/objects` — EVERY object with its `sha256`.
 *
 * This ONE call is the discovery AND the cache-invalidation primitive: folders,
 * ownership and per-image change detection all come from it (docs/17 row 42).
 * `prefix` is the route's only filter, and an unmatchable prefix is a `400` the
 * service sends on purpose — so callers pass a legal prefix or none.
 */
export async function listObjects(
  target: StoreTarget,
  prefix?: string,
  signal?: AbortSignal,
): Promise<ObjectEntry[]> {
  const query = prefix === undefined || prefix === '' ? '' : `?prefix=${encodeURIComponent(prefix)}`;
  const path = `${storePath(target, '/objects')}${query}`;
  const response = await requestRaw(target, path, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  const body = await readJson(response, listResponseSchema, path);
  return body.objects;
}

/** `GET /stores/{store}/objects/{name}` — the exact bytes that were PUT. */
export async function getObject(
  target: StoreTarget,
  name: string,
  signal?: AbortSignal,
): Promise<ObjectBytes> {
  const path = storePath(target, `/objects/${encodeURIComponent(name)}`);
  const response = await requestRaw(target, path, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = response.headers.get('x-serverstore-sha256');
  if (sha256 === null || !/^[0-9a-f]{64}$/.test(sha256)) {
    // Without the service's own hash the app could not prove what it received;
    // reporting success here would be exactly the silent trust rule 1 forbids.
    throw new ServerStoreError(
      'invalid-response',
      `ServerStore returned ${name} without a readable x-serverstore-sha256 header, so the download cannot be verified.`,
    );
  }
  if (bytes.length === 0) {
    throw new ServerStoreError('invalid-response', `ServerStore returned ${name} with zero bytes.`);
  }
  return { bytes, sha256, contentType: response.headers.get('content-type') ?? '' };
}

/**
 * `PUT /stores/{store}/objects/{name}` — the body IS the object. An
 * unconditional overwrite (the API has no create-only variant), so callers
 * check the listing first when an overwrite would lose something.
 */
export async function putObject(
  target: StoreTarget,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<PutResult> {
  const path = storePath(target, `/objects/${encodeURIComponent(name)}`);
  const response = await requestRaw(target, path, {
    method: 'PUT',
    body: bytes,
    ...(signal === undefined ? {} : { signal }),
  });
  return readJson(response, putResponseSchema, path);
}

/** `DELETE /stores/{store}/objects/{name}` — 204, no body. */
export async function deleteObject(
  target: StoreTarget,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = storePath(target, `/objects/${encodeURIComponent(name)}`);
  await requestRaw(target, path, { method: 'DELETE', ...(signal === undefined ? {} : { signal }) });
}

export type { ServerStoreErrorCode };
