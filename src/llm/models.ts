/**
 * THE model-knowledge seam: one GET /models fetch (zod-validated, session
 * cached) plus pure capability functions. Later slices ask THESE functions
 * which refinement path a model supports — they never guess from an id.
 *
 * MEASURED 2026 snapshot (.gate-logs/models-*-snapshot.json, docs/17 row 2):
 * the bare `GET /models` returns TEXT-output models only (460 entries, 11
 * with image output — the chat-image models). Images-API-only models (flux,
 * gpt-image, seedream, recraft …) appear only with `output_modalities=all`
 * (625 entries, 57 with image output). Hence the query parameter.
 */
import { z } from 'zod';

import { fetchWithRetries, openRouterHeaders, readJson } from '@/llm/client';

const modelSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  architecture: z.looseObject({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  supported_parameters: z.array(z.string()),
  // Prices are USD decimal strings; "-1" marks router models (variable).
  pricing: z.record(z.string(), z.unknown()),
});

export const modelsResponseSchema = z.looseObject({ data: z.array(modelSchema) });

export type OpenRouterModel = z.infer<typeof modelSchema>;

export const MODELS_PATH = '/models?output_modalities=all';

let cache: Promise<OpenRouterModel[]> | null = null;

/** The live model list, fetched once per session. A failure is NOT cached,
 * so the next call retries; it propagates loudly (never an empty list). */
export function listModels(apiKey: string): Promise<OpenRouterModel[]> {
  if (cache === null) {
    const pending = (async () => {
      const response = await fetchWithRetries(MODELS_PATH, { headers: openRouterHeaders(apiKey) });
      return (await readJson(response, modelsResponseSchema)).data;
    })();
    cache = pending;
    pending.catch(() => {
      if (cache === pending) cache = null;
    });
  }
  return cache;
}

/** Test-only: drop the session cache. */
export function resetModelCache(): void {
  cache = null;
}

/** Output includes image → usable for generation (Images API). */
export function canGenerateImages(model: OpenRouterModel): boolean {
  return model.architecture.output_modalities.includes('image');
}

/** Input includes image → can take a reference image. */
export function acceptsImageInput(model: OpenRouterModel): boolean {
  return model.architecture.input_modalities.includes('image');
}

/**
 * The multi-turn chat-refinement path: image in, image out AND text out.
 * Owner decision (ledger row 4): only models that also answer with text are
 * refinement-chat models — image-only models (flux, gpt-image, seedream…)
 * stay available for the initial generation through the image picker.
 */
export function canRefineViaChat(model: OpenRouterModel): boolean {
  return acceptsImageInput(model) && canGenerateImages(model) && producesTextToo(model);
}

/** Output includes text as well as image (the chat-image models). */
export function producesTextToo(model: OpenRouterModel): boolean {
  return model.architecture.output_modalities.includes('text');
}

/**
 * Output includes audio → can render a song on the music path
 * (`src/llm/music.ts`). The capability cannot tell a MUSIC model from a SPEECH
 * model (OpenRouter lists both as `audio` out), so the Music picker shows every
 * audio-output model and the owner picks — the app never guesses from an id.
 */
export function canGenerateAudio(model: OpenRouterModel): boolean {
  return model.architecture.output_modalities.includes('audio');
}

/**
 * The song writer (docs/17 row 52): a TEXT-only model that honours a strict
 * `json_schema` response format, so the owner's free-text direction is read by
 * a model into a validated song sheet (AGENTS rule 5). Models that also answer
 * with images or audio are excluded — they are generators, not writers.
 */
export function canWriteSongSheet(model: OpenRouterModel): boolean {
  const out = model.architecture.output_modalities;
  return (
    out.includes('text') &&
    !out.includes('image') &&
    !out.includes('audio') &&
    model.supported_parameters.includes('structured_outputs')
  );
}
