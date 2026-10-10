/**
 * THE video-generation seam (docs/17 row 56): OpenRouter's ASYNCHRONOUS video
 * API, through the one transport.
 *
 * READ 2026-10-10 from OpenRouter's video-generation guide and API reference
 * (openrouter.ai/docs/guides/overview/multimodal/video-generation):
 *   - `POST /videos` with `model`, `prompt` and optional `duration` (seconds),
 *     `resolution`, `aspect_ratio`, `generate_audio`, `frame_images`
 *     (`[{ type: 'image_url', image_url: { url }, frame_type: 'first_frame' }]`)
 *     answers 202 with `{ id, polling_url, status: 'pending' }`;
 *   - `GET /videos/{id}` reports `status` (`pending` | `in_progress` |
 *     `completed` | `failed`; webhooks add `cancelled` | `expired`), `error` on
 *     failure, and `unsigned_urls` + `usage.cost` once completed;
 *   - `GET /videos/{id}/content?index=0` (Authorization required) is the bytes;
 *   - `GET /videos/models` lists the video models WITH their per-model limits
 *     (`supported_durations`, `supported_resolutions`, `supported_aspect_ratios`,
 *     `supported_frame_images`, `generate_audio`, `pricing_skus`); a value
 *     outside a model's list is a 400 that names the valid options.
 *
 * Every failure is LOUD: a status this module does not know, a `failed` job, an
 * empty download, and bytes in no known video container all
 * throw or are reported as failures — never an empty video.
 */
import { z } from 'zod';

import { fetchWithRetries, openRouterHeaders, readJson } from '@/llm/client';
import { MissingApiKeyError, OpenRouterError } from '@/llm/errors';
import { imageUrlPart } from '@/llm/images';
import { sniffVideoFormat } from '@/lib/videoFormat';

/* ------------------------------------------------------------- the models */

const videoModelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  supported_durations: z.array(z.number()).nullable(),
  supported_resolutions: z.array(z.string()).nullable(),
  supported_aspect_ratios: z.array(z.string()).nullable(),
  supported_frame_images: z.array(z.string()).nullable(),
  generate_audio: z.boolean().nullable(),
  pricing_skus: z.record(z.string(), z.string()).nullish(),
});
export type VideoModel = z.infer<typeof videoModelSchema>;

const videoModelsResponseSchema = z.looseObject({ data: z.array(videoModelSchema) });

export const VIDEO_MODELS_PATH = '/videos/models';

let cache: Promise<VideoModel[]> | null = null;

/** The live video-model list, fetched once per session. A failure is NOT
 * cached (the next call retries) and propagates loudly — never an empty list. */
export function listVideoModels(apiKey: string): Promise<VideoModel[]> {
  if (cache === null) {
    const pending = (async () => {
      const response = await fetchWithRetries(VIDEO_MODELS_PATH, {
        headers: openRouterHeaders(apiKey),
      });
      return (await readJson(response, videoModelsResponseSchema)).data;
    })();
    cache = pending;
    pending.catch(() => {
      if (cache === pending) cache = null;
    });
  }
  return cache;
}

/** Test-only: drop the session cache. */
export function resetVideoModelCache(): void {
  cache = null;
}

/** The model can start from a given first frame (image-to-video). */
export function acceptsFirstFrame(model: VideoModel): boolean {
  return model.supported_frame_images?.includes('first_frame') ?? false;
}

/** The model can make a soundtrack with the video. */
export function canGenerateVideoAudio(model: VideoModel): boolean {
  return model.generate_audio === true;
}

/* --------------------------------------------------------------- the job */

export interface VideoSubmitRequest {
  apiKey: string;
  model: string;
  prompt: string;
  /** Each option is SENT only when set; unset = the model's own default. */
  duration: number | null;
  resolution: string | null;
  aspectRatio: string | null;
  generateAudio: boolean | null;
  /** A `data:` URL for the first frame, or null for text-to-video. */
  firstFrameDataUrl: string | null;
  signal?: AbortSignal | undefined;
}

const submitResponseSchema = z.looseObject({ id: z.string().min(1) });

/** Start a job; resolves with OpenRouter's job id. */
export async function submitVideo(req: VideoSubmitRequest): Promise<string> {
  if (req.apiKey === '') throw new MissingApiKeyError();
  const response = await fetchWithRetries('/videos', {
    method: 'POST',
    headers: openRouterHeaders(req.apiKey),
    body: JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      ...(req.duration === null ? {} : { duration: req.duration }),
      ...(req.resolution === null ? {} : { resolution: req.resolution }),
      ...(req.aspectRatio === null ? {} : { aspect_ratio: req.aspectRatio }),
      ...(req.generateAudio === null ? {} : { generate_audio: req.generateAudio }),
      ...(req.firstFrameDataUrl === null
        ? {}
        : {
            frame_images: [{ ...imageUrlPart(req.firstFrameDataUrl), frame_type: 'first_frame' }],
          }),
    }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  return (await readJson(response, submitResponseSchema)).id;
}

const pollResponseSchema = z.looseObject({
  status: z.string(),
  error: z
    .union([z.string(), z.looseObject({ message: z.string().optional() })])
    .nullish(),
  usage: z.looseObject({ cost: z.number().nullish() }).nullish(),
});

/** One poll, read into what the caller must do next. */
export type VideoJobState =
  | { kind: 'active'; status: 'pending' | 'in_progress' }
  | { kind: 'completed'; costUsd: number | null }
  | { kind: 'failed'; error: string };

const FAILED_STATUSES = new Set(['failed', 'cancelled', 'expired']);

/** Poll a job once. An unknown status THROWS — it is never read as "still working". */
export async function pollVideo(apiKey: string, jobId: string): Promise<VideoJobState> {
  if (apiKey === '') throw new MissingApiKeyError();
  const response = await fetchWithRetries(`/videos/${encodeURIComponent(jobId)}`, {
    headers: openRouterHeaders(apiKey),
  });
  const body = await readJson(response, pollResponseSchema);
  if (body.status === 'pending' || body.status === 'in_progress') {
    return { kind: 'active', status: body.status };
  }
  if (body.status === 'completed') {
    // The output is not read here: the download is the proof, and an empty or
    // missing one fails loudly there.
    return { kind: 'completed', costUsd: body.usage?.cost ?? null };
  }
  if (FAILED_STATUSES.has(body.status)) {
    const reason =
      typeof body.error === 'string' ? body.error : (body.error?.message ?? 'no reason given');
    return { kind: 'failed', error: `The video job ${body.status}: ${reason}` };
  }
  throw new OpenRouterError(
    'invalid-response',
    response.status,
    `the video job reports an unknown status "${body.status}"`,
  );
}

export interface DownloadedVideo {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/** The finished video's bytes, typed by their own signature. */
export async function downloadVideo(apiKey: string, jobId: string): Promise<DownloadedVideo> {
  if (apiKey === '') throw new MissingApiKeyError();
  const response = await fetchWithRetries(`/videos/${encodeURIComponent(jobId)}/content?index=0`, {
    headers: openRouterHeaders(apiKey),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new OpenRouterError('invalid-response', response.status, 'the video download was empty');
  }
  return { bytes, mimeType: sniffVideoFormat(bytes).mimeType };
}
