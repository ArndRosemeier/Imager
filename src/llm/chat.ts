/**
 * THE chat-completion seam (slice 4): `POST /chat/completions` through the one
 * transport, for the multi-turn refinement model that answers with TEXT AS
 * WELL AS images (`canRefineViaChat`, docs/17 rows 1c/4). It is NOT the Images
 * API path (`src/llm/images.ts`, `/images`) and never merges with it — the two
 * endpoints take different request shapes for the same intent.
 *
 * MEASURED 2026-09-25 against `https://openrouter.ai/openapi.json` (raw
 * snapshot `.gate-logs/openapi-snapshot.json`):
 *   - request: `modalities: ["text","image"]` (values `text|image|audio`) plus
 *     `image_config` (free-form provider keys, e.g. `aspect_ratio`, `quality`),
 *     `model` and `messages`;
 *   - `messages` is the role-discriminated union and an ASSISTANT message may
 *     carry `images: [{ image_url: { url } }]` (`ChatAssistantImages`, "for
 *     requests and responses") — that is how a prior turn's generated image is
 *     sent back, which is what makes "now add rain" work;
 *   - response: `choices[].message` is a `ChatAssistantMessage` — `content`
 *     (string | content parts | null) plus the same `images` field, and
 *     `usage.cost`.
 *
 * STREAMING/SSE IS DELIBERATELY OUT of this slice (docs/17 row 12): the
 * endpoint also documents an SSE response content type, but partial-image SSE
 * is a follow-up. A non-streaming call with the same 5-minute headers timeout
 * as the image path is enough for v1 — that reason is recorded, not half-built
 * here.
 *
 * A 200 body carrying the error envelope FAILS LOUDLY (the donor-derived
 * `parseOpenRouterErrorEnvelope`), and so does a completion with neither text
 * nor images: an empty success is not a result (rule 1).
 */
import { z } from 'zod';

import {
  IMAGE_RENDER_HEADERS_TIMEOUT_MS,
  fetchWithRetries,
  openRouterHeaders,
  readJson,
} from '@/llm/client';
import { MissingApiKeyError, OpenRouterError, parseOpenRouterErrorEnvelope } from '@/llm/errors';
import { imageUrlPart } from '@/llm/images';
import { bytesFromBase64 } from '@/lib/base64';

/** One turn of the conversation as this app replays it. */
export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  text: string;
  /**
   * `data:` URLs of the images this message produced (assistant turns). The
   * caller re-encodes them through `src/features/refine/reference.ts`, so the
   * ≤1024px cap is applied in ONE place.
   */
  imageDataUrls?: readonly string[] | undefined;
}

export interface ChatRequest {
  apiKey: string;
  model: string;
  /** In order, oldest first. */
  messages: readonly ChatTurnMessage[];
  /** Free-form provider image options (`image_config`), e.g. `{ aspect_ratio }`. */
  imageConfig?: Record<string, string | number | readonly unknown[]> | undefined;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
}

export interface ChatImage {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

export interface ChatCompletion {
  text: string;
  images: ChatImage[];
  /** The model the response names; the request's model when it names none. */
  model: string;
  costUsd: number | null;
}

const imagePartSchema = z.looseObject({
  image_url: z.looseObject({ url: z.string().min(1) }),
});

const textPartSchema = z.looseObject({ type: z.string().optional(), text: z.string().optional() });

const assistantMessageSchema = z.looseObject({
  content: z.union([z.string(), z.array(textPartSchema), z.null()]).optional(),
  images: z.array(imagePartSchema).nullish(),
});

const chatResponseSchema = z.looseObject({
  choices: z.array(z.looseObject({ message: assistantMessageSchema.optional() })).optional(),
  usage: z.looseObject({ cost: z.number().nullish() }).optional(),
  model: z.string().optional(),
});

/** `content` may be a plain string or a list of content parts (OpenRouter
 * returns either); both are collapsed to text, other part kinds ignored. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as z.infer<typeof textPartSchema>[])
    .flatMap((part) => (part.text === undefined ? [] : [part.text]))
    .join('\n');
}

const DATA_URL_PREFIX = 'data:';
const BASE64_SUFFIX = ';base64';

/**
 * The response's generated image is a `data:` URL (the documented
 * `ChatAssistantImages` example). Anything else, a non-base64 encoding, or an
 * empty payload is a loud boundary failure — never a guessed type or zero
 * bytes standing in for an image (rule 1/3).
 */
function imageFromDataUrl(url: string, status: number): ChatImage {
  if (!url.startsWith(DATA_URL_PREFIX)) {
    throw new OpenRouterError(
      'invalid-response',
      status,
      `chat image is not a data: URL: "${url.slice(0, 60)}"`,
    );
  }
  const comma = url.indexOf(',');
  const header = comma === -1 ? '' : url.slice(DATA_URL_PREFIX.length, comma);
  if (!header.endsWith(BASE64_SUFFIX)) {
    throw new OpenRouterError(
      'invalid-response',
      status,
      `chat image data URL is not base64-encoded: "${header}"`,
    );
  }
  const mimeType = header.slice(0, -BASE64_SUFFIX.length);
  if (mimeType === '') {
    throw new OpenRouterError('invalid-response', status, 'chat image data URL has no MIME type');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = bytesFromBase64(url.slice(comma + 1));
  } catch (error) {
    throw new OpenRouterError(
      'invalid-response',
      status,
      `chat image data URL is not valid base64 (${String(error)})`,
    );
  }
  if (bytes.length === 0) {
    throw new OpenRouterError('invalid-response', status, 'chat image data URL carries no bytes');
  }
  return { bytes, mimeType };
}

/**
 * One message in the request shape. The image part body comes from the ONE
 * builder (`src/llm/images.ts`).
 *
 * A USER message with attached images sends multimodal `content` parts —
 * `[{type:'text', text}, {type:'image_url', image_url:{url}}]` — which is how
 * OpenRouter documents image input on `/chat/completions` (the same part shape
 * the Images API takes as `input_references`). A user message with NO image
 * stays a plain string, byte-identical to what it sent before. Attached images
 * are NEVER dropped silently: that is the whole point of the owner's "have an
 * image as the base of the chat" (ledger row 16) — before it, this branch
 * returned `content: text` and an attached image vanished.
 *
 * An ASSISTANT message carries its generated images in the `images` field
 * (OpenAPI `ChatAssistantMessage.images`, valid for requests and responses).
 */
function requestMessage(message: ChatTurnMessage): Record<string, unknown> {
  const images = message.imageDataUrls ?? [];
  if (message.role === 'user') {
    if (images.length === 0) return { role: 'user', content: message.text };
    return {
      role: 'user',
      content: [
        ...(message.text === '' ? [] : [{ type: 'text', text: message.text }]),
        ...images.map((dataUrl) => imageUrlPart(dataUrl)),
      ],
    };
  }
  return {
    role: 'assistant',
    content: message.text,
    ...(images.length === 0 ? {} : { images: images.map((dataUrl) => imageUrlPart(dataUrl)) }),
  };
}

/**
 * One chat completion. Non-OK HTTP → typed `OpenRouterError` (with 429/5xx
 * retried by the transport); a 200 error envelope, a zod failure, a data URL
 * that is not a base64 image, and a completion with neither text nor images
 * all THROW.
 */
export async function chatCompletion(req: ChatRequest): Promise<ChatCompletion> {
  if (req.apiKey === '') throw new MissingApiKeyError();
  const response = await fetchWithRetries(
    '/chat/completions',
    {
      method: 'POST',
      headers: openRouterHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages.map(requestMessage),
        modalities: ['text', 'image'],
        ...(req.imageConfig === undefined ? {} : { image_config: req.imageConfig }),
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    },
    req.retryBackoffs,
    IMAGE_RENDER_HEADERS_TIMEOUT_MS,
  );
  const body: unknown = await readJson(response, z.unknown());
  // A 200 can still carry the error envelope — the same typed error as HTTP.
  const envelope = parseOpenRouterErrorEnvelope(body);
  if (envelope !== null) {
    throw new OpenRouterError(
      'http',
      response.status,
      envelope.message ?? 'chat API returned an error body',
      envelope.errorType ?? envelope.code,
    );
  }
  const parsed = chatResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenRouterError('invalid-response', response.status, parsed.error.message);
  }
  const message = parsed.data.choices?.[0]?.message;
  const text = textFromContent(message?.content);
  const images = (message?.images ?? []).map((part) =>
    imageFromDataUrl(part.image_url.url, response.status),
  );
  if (text.trim() === '' && images.length === 0) {
    throw new OpenRouterError(
      'invalid-response',
      response.status,
      'chat completion returned neither text nor images',
    );
  }
  return {
    text,
    images,
    model: parsed.data.model ?? req.model,
    costUsd: parsed.data.usage?.cost ?? null,
  };
}
