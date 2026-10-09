import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OpenRouterError } from '@/llm/errors';
import {
  acceptsImageInput,
  canGenerateAudio,
  canGenerateImages,
  canRefineViaChat,
  canWriteSongSheet,
  listModels,
  modelsResponseSchema,
  resetModelCache,
} from '@/llm/models';
import { jsonResponse, modelsFixture } from '../helpers';

beforeEach(() => {
  resetModelCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const models = modelsResponseSchema.parse(modelsFixture()).data;
const ids = (pred: (m: (typeof models)[number]) => boolean): string[] =>
  models
    .filter(pred)
    .map((m) => m.id)
    .sort();

it('classifies the real fixture entries', () => {
  expect(ids(canGenerateImages)).toEqual([
    'black-forest-labs/flux.2-pro',
    'bytedance-seed/seedream-4.5',
    'google/gemini-2.5-flash-image',
    'google/gemini-3-pro-image-preview',
    'inclusionai/ming-image-0.1-design',
    'openai/gpt-5-image-mini',
    'openai/gpt-image-1',
    'openrouter/auto',
    'recraft/recraft-v4.1-flash',
  ]);
  // Chat refiners need image in, image out AND text out (ledger row 4):
  // image-only models (flux, seedream, gpt-image) are generation-only.
  expect(ids(canRefineViaChat)).toEqual([
    'google/gemini-2.5-flash-image',
    'google/gemini-3-pro-image-preview',
    'openai/gpt-5-image-mini',
    'openrouter/auto',
  ]);
  // Vision chat models accept images but cannot produce one.
  const gpt4o = models.find((m) => m.id === 'openai/gpt-4o');
  expect(gpt4o && acceptsImageInput(gpt4o)).toBe(true);
  expect(gpt4o && canRefineViaChat(gpt4o)).toBe(false);
});

it('fetches /models once per session through the client', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(modelsFixture())));
  vi.stubGlobal('fetch', fetchMock);
  const first = await listModels('');
  await listModels('');
  expect(first).toHaveLength(13);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
    'https://openrouter.ai/api/v1/models?output_modalities=all',
  );
});

it('a /models body failing zod is a loud OpenRouterError, not an empty list', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({ data: [{ id: 'x/y' }] })));
  const error: unknown = await listModels('').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpenRouterError);
  expect((error as OpenRouterError).kind).toBe('invalid-response');
  // A failure is not cached: the next call fetches again.
  vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(modelsFixture())));
  await expect(listModels('')).resolves.toHaveLength(13);
});

/**
 * The music slice's two capabilities (docs/17 row 52), on the reconstructed
 * audio listing (`tests/fixtures/models-music.json`).
 */
it('canGenerateAudio and canWriteSongSheet read modalities and parameters, never ids', () => {
  const music = modelsResponseSchema.parse(
    JSON.parse(readFileSync('tests/fixtures/models-music.json', 'utf8')),
  ).data;
  expect(music.filter(canGenerateAudio).map((m) => m.id)).toEqual([
    'google/lyria-3-pro-preview',
    'google/lyria-3-clip-preview',
    'openai/gpt-audio',
  ]);
  // Lyria answers with text too but is an audio model; Nano Banana answers with
  // images; only the text-only structured-output model is a writer.
  expect(music.filter(canWriteSongSheet).map((m) => m.id)).toEqual([
    'meta-llama/llama-3.3-70b-instruct',
  ]);
});
