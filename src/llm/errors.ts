/**
 * Typed OpenRouter failures (ported, trimmed, from Campaigner
 * `src/llm/openrouterErrors.ts`). A leaf module: the client and the models
 * seam import it, never the other way around. The fallback-chain
 * classification layer of the donor is deliberately NOT ported (no fallback
 * chain exists — owner hasn't asked).
 */
import { z } from 'zod';

export type OpenRouterErrorKind =
  /** Non-OK HTTP response (retries exhausted, bad request, auth, …). */
  | 'http'
  /** A 200 whose body failed zod validation at the boundary (rule 3). */
  | 'invalid-response';

export class OpenRouterError extends Error {
  readonly kind: OpenRouterErrorKind;
  readonly status: number;
  readonly bodyText: string;
  /** `metadata.error_type` (or envelope code) when the body carried one. */
  readonly code: number | string | undefined;

  constructor(kind: OpenRouterErrorKind, status: number, bodyText: string, code?: number | string) {
    const snippet = bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;
    super(`OpenRouter request failed (${String(status)})${snippet === '' ? '' : `: ${snippet}`}`);
    this.name = 'OpenRouterError';
    this.kind = kind;
    this.status = status;
    this.bodyText = bodyText;
    this.code = code;
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('No OpenRouter API key configured — enter one in Settings.');
    this.name = 'MissingApiKeyError';
  }
}

/** OpenRouter's documented error envelope
 * `{ error: { code, message, metadata: { error_type } } }` — loose on purpose,
 * only the consumed fields are declared. */
const envelopeSchema = z.looseObject({
  error: z
    .looseObject({
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
      metadata: z.looseObject({ error_type: z.string().optional() }).nullish(),
    })
    .optional(),
});

export interface OpenRouterErrorEnvelopeInfo {
  code: number | string | undefined;
  message: string | undefined;
  errorType: string | undefined;
}

/** Parses a decoded JSON body into the envelope fields; null when the body is
 * not envelope-shaped. */
export function parseOpenRouterErrorEnvelope(value: unknown): OpenRouterErrorEnvelopeInfo | null {
  const parsed = envelopeSchema.safeParse(value);
  const error = parsed.success ? parsed.data.error : undefined;
  if (error === undefined) return null;
  return { code: error.code, message: error.message, errorType: error.metadata?.error_type };
}

/** `metadata.error_type` from a raw body; undefined for non-JSON bodies (the
 * raw text still rides the thrown error, nothing is lost). */
export function errorTypeFromBody(bodyText: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  return parseOpenRouterErrorEnvelope(json)?.errorType;
}
