/**
 * The ServerStore error vocabulary (docs/17 row 42).
 *
 * The API documents `code` as STABLE and `message` as human-facing and
 * changeable (the ServerStore client contract, "Errors"), so this seam branches
 * on the code and keeps the server's message for the human. Failures are typed so the
 * app's ONE toast surface (`src/lib/toast.ts`, rule 2) can say what actually
 * happened — never `console.error` only.
 */

/** Every `code` the service documents. Branching target; never a guess. */
export const SERVER_STORE_ERROR_CODES = [
  'bad_request',
  'invalid_name',
  'invalid_body',
  'invalid_scope',
  'payload_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'store_exists',
  'name_taken',
  'unsupported_store_kind',
  'internal',
] as const;
export type ServerStoreErrorCode = (typeof SERVER_STORE_ERROR_CODES)[number];

/**
 * What went wrong, in the app's own words:
 *  * `api`   — the service answered with its documented error envelope.
 *  * `transport` — the request never produced a response (offline, DNS, CORS,
 *    timeout): no envelope exists to report.
 *  * `invalid-response` — a response arrived but is not what the contract says
 *    (non-JSON body, a body that fails zod): a loud parse failure (rule 1/3).
 */
export type ServerStoreErrorKind = 'api' | 'transport' | 'invalid-response';

/**
 * The service's `Retry-After` on a `429`, in whole seconds (>= 1), or `null`.
 * It is CORS-exposed, so a browser can read it and the app can tell the owner
 * how long to wait instead of guessing (the service decides `429` before the
 * body is read and never processes the refused request).
 */
export function retryAfterSecondsFrom(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

export class ServerStoreError extends Error {
  readonly kind: ServerStoreErrorKind;
  /** The HTTP status when there was one, else `null`. */
  readonly status: number | null;
  /** The service's stable `code`, for an `api` error; else `null`. */
  readonly code: ServerStoreErrorCode | null;
  /** A `429`'s `Retry-After`, in seconds, when the service sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: ServerStoreErrorKind,
    message: string,
    options: {
      status?: number | null;
      code?: ServerStoreErrorCode | null;
      retryAfterSeconds?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ServerStoreError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** A `401`/`403` in one place: the key is missing, unknown, expired or scoped
 * elsewhere. The UI shows this verbatim rather than inventing a cause. */
export function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof ServerStoreError && (error.code === 'unauthorized' || error.code === 'forbidden')
  );
}

const KNOWN_CODES = new Set<string>(SERVER_STORE_ERROR_CODES);

/** The documented envelope, narrowed from an unknown body. */
export function envelopeFromBody(body: unknown): { code: ServerStoreErrorCode; message: string } | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error: unknown = body.error;
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown; message?: unknown };
  if (typeof record.code !== 'string' || !KNOWN_CODES.has(record.code)) return null;
  // `KNOWN_CODES` is typed as `Set<string>`, so `has` does not narrow; the
  // value is checked against the vocabulary immediately above.
  const code: ServerStoreErrorCode = SERVER_STORE_ERROR_CODES.find((entry) => entry === record.code) ?? 'internal';
  return {
    code,
    message: typeof record.message === 'string' ? record.message : code,
  };
}

/**
 * The error for a non-OK HTTP response: the envelope's code and message when it
 * parses, otherwise an honest `invalid-response` naming the status and the body
 * — a server that answers HTML (a proxy error page) must not be reported as an
 * API refusal it never sent.
 */
export function errorFromResponse(response: Response, bodyText: string): ServerStoreError {
  const status = response.status;
  const retryAfterSeconds = status === 429 ? retryAfterSecondsFrom(response) : null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    body = undefined;
  }
  const envelope = envelopeFromBody(body);
  if (envelope !== null) {
    return new ServerStoreError('api', `ServerStore refused (${envelope.code}): ${envelope.message}`, {
      status,
      code: envelope.code,
      retryAfterSeconds,
    });
  }
  const snippet = bodyText.length > 200 ? `${bodyText.slice(0, 200)}…` : bodyText;
  return new ServerStoreError(
    'invalid-response',
    `ServerStore answered HTTP ${String(status)} without its error envelope: ${snippet === '' ? '(empty body)' : snippet}`,
    { status, retryAfterSeconds },
  );
}
