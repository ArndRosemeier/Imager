/**
 * THE per-model Images-API limits seam: one session-cached, PUBLIC
 * `GET /images/models` (zod-validated). The UI bounds its count and aspect
 * controls by what the SELECTED model publishes here — never by guesses.
 *
 * MEASURED 2026-09-25 (.gate-logs/images-models-snapshot.json, docs/17 row 5):
 * 55 entries; `supported_parameters` is an OBJECT of descriptors
 * `{type:'range',min,max}` | `{type:'enum',values}` | `{type:'boolean'}`.
 * `n` is published for 51 (max 1/4/6/10); 4 publish no `n` at all
 * (meta/muse-image, krea/krea-2-*) — read as "n not supported" → count 1.
 * `aspect_ratio` enum for 52.
 */
import { z } from 'zod';

import { fetchWithRetries, openRouterHeaders, readJson } from '@/llm/client';

const descriptorSchema = z.union([
  z.looseObject({ type: z.literal('range'), min: z.number(), max: z.number() }),
  z.looseObject({ type: z.literal('enum'), values: z.array(z.string()) }),
  z.looseObject({ type: z.string() }),
]);

const imageModelSchema = z.looseObject({
  id: z.string().min(1),
  supported_parameters: z.record(z.string(), descriptorSchema),
});

export const imageModelsResponseSchema = z.looseObject({ data: z.array(imageModelSchema) });

export const IMAGE_MODELS_PATH = '/images/models';

/** What the UI may offer for one model. */
export interface ImageModelLimits {
  /** false → the model is absent from /images/models: loud notice, count 1. */
  listed: boolean;
  maxCount: number;
  /** Published aspect ratios; empty → the control is hidden, none is sent. */
  aspectRatios: string[];
}

let cache: Promise<Map<string, ImageModelLimits>> | null = null;

function limitsOf(params: Record<string, z.infer<typeof descriptorSchema>>): ImageModelLimits {
  const n = params.n;
  const ar = params.aspect_ratio;
  return {
    listed: true,
    maxCount: n !== undefined && 'max' in n && typeof n.max === 'number' ? Math.max(1, n.max) : 1,
    aspectRatios:
      ar !== undefined && 'values' in ar && Array.isArray(ar.values) ? (ar.values as string[]) : [],
  };
}

/** Session-cached limits by model id. Failure is NOT cached and propagates. */
export function listImageModelLimits(apiKey: string): Promise<Map<string, ImageModelLimits>> {
  if (cache === null) {
    const pending = (async () => {
      const response = await fetchWithRetries(IMAGE_MODELS_PATH, {
        headers: openRouterHeaders(apiKey),
      });
      const { data } = await readJson(response, imageModelsResponseSchema);
      return new Map(data.map((m) => [m.id, limitsOf(m.supported_parameters)]));
    })();
    cache = pending;
    pending.catch(() => {
      if (cache === pending) cache = null;
    });
  }
  return cache;
}

export const UNLISTED_LIMITS: ImageModelLimits = { listed: false, maxCount: 1, aspectRatios: [] };

/** Limits for one id; an unlisted model gets the loud UNLISTED_LIMITS. */
export function limitsFor(all: Map<string, ImageModelLimits>, modelId: string): ImageModelLimits {
  return all.get(modelId) ?? UNLISTED_LIMITS;
}

/** Test-only. */
export function resetImageModelCache(): void {
  cache = null;
}
