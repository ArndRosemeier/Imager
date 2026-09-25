/**
 * THE image-generation seam (ported, trimmed, from Campaigner
 * `src/llm/imageGen.ts`): `POST /images` through the one transport. Slice 3
 * adds the donor's `input_references` field, so ONE seam serves both a
 * text-to-image run and a refinement — there is no second image client.
 * Deliberately DROPPED from the donor: the fallback chain (owner, ledger
 * row 3), the donor's silent 400-retry WITHOUT the references, and the
 * `n`-cap retry heuristic — the count is bounded up front by
 * `src/llm/imageModels.ts`.
 */
import { z } from 'zod';

import { fetchWithRetries, openRouterHeaders, readJson } from '@/llm/client';
import { MissingApiKeyError, OpenRouterError, parseOpenRouterErrorEnvelope } from '@/llm/errors';
import { bytesFromBase64 } from '@/lib/base64';

/** Image generation is not streamed: headers arrive only once rendered. */
export const IMAGE_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;

const imagesResponseSchema = z.looseObject({
  data: z
    .array(
      z
        .looseObject({ b64_json: z.string().optional(), media_type: z.string().optional() })
        .nullable(),
    )
    .optional(),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

/**
 * One reference image in the shape `POST /images` documents
 * (`input_references: [{ type: 'image_url', image_url: { url } }]`, the
 * donor's `imageGen.ts`). `url` is a `data:` URL produced by
 * `src/features/refine/reference.ts` — the seam that owns the ≤1024px cap.
 */
export interface ReferenceInput {
  dataUrl: string;
}

export interface GenerateRequest {
  apiKey: string;
  model: string;
  prompt: string;
  n: number;
  aspectRatio?: string | undefined;
  /** Empty/absent = text-to-image. Non-empty = a refinement of those images. */
  inputReferences?: readonly ReferenceInput[] | undefined;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
}

export interface GeneratedImage {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

export interface GeneratedImages {
  images: GeneratedImage[];
  costUsd: number | null;
  /** Candidates dropped as filtered (null / empty b64). Callers MUST show it. */
  filteredCount: number;
}

/** The API documents `media_type` per image; a missing one is loud (rule 1),
 * never a guessed type (the download extension depends on it). */
function mediaType(value: string | undefined, status: number): string {
  if (value === undefined || value === '') {
    throw new OpenRouterError('invalid-response', status, 'image returned without media_type');
  }
  return value;
}

export async function generateImages(req: GenerateRequest): Promise<GeneratedImages> {
  if (req.apiKey === '') throw new MissingApiKeyError();
  const references = req.inputReferences ?? [];
  const response = await fetchWithRetries(
    '/images',
    {
      method: 'POST',
      headers: openRouterHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        n: req.n,
        ...(req.aspectRatio === undefined ? {} : { aspect_ratio: req.aspectRatio }),
        ...(references.length === 0
          ? {}
          : {
              input_references: references.map((reference) => ({
                type: 'image_url',
                image_url: { url: reference.dataUrl },
              })),
            }),
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    },
    req.retryBackoffs,
    IMAGE_HEADERS_TIMEOUT_MS,
  );
  const body: unknown = await readJson(response, z.unknown());
  // A 200 can still carry the error envelope — the same typed error as HTTP.
  const envelope = parseOpenRouterErrorEnvelope(body);
  if (envelope !== null) {
    throw new OpenRouterError(
      'http',
      response.status,
      envelope.message ?? 'image API returned an error body',
      envelope.errorType ?? envelope.code,
    );
  }
  const parsed = imagesResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenRouterError('invalid-response', response.status, parsed.error.message);
  }
  const entries = parsed.data.data ?? [];
  const images = entries.flatMap((e) => {
    const b64 = e?.b64_json;
    return b64 === undefined || b64 === ''
      ? []
      : [{ bytes: bytesFromBase64(b64), mimeType: mediaType(e?.media_type, response.status) }];
  });
  if (images.length === 0) {
    throw new OpenRouterError(
      'invalid-response',
      response.status,
      entries.length === 0
        ? 'image API returned no images'
        : `all ${String(entries.length)} candidates were filtered`,
    );
  }
  return {
    images,
    costUsd: parsed.data.usage?.cost ?? null,
    filteredCount: entries.length - images.length,
  };
}
