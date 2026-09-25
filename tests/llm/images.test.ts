import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

import { generateImages } from '@/llm/images';
import { limitsFor, listImageModelLimits, resetImageModelCache } from '@/llm/imageModels';
import { jsonResponse } from '../helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  resetImageModelCache();
});

const req = { apiKey: 'sk', model: 'm/x', prompt: 'a cat', n: 2 };

it('decodes b64 images, reports cost and a partial filter', async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      jsonResponse({
        data: [{ b64_json: btoa('abc'), media_type: 'image/webp' }, null, { b64_json: '' }],
        usage: { cost: 0.04 },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const out = await generateImages(req);
  expect(out.images).toHaveLength(1);
  expect(out.images[0]?.mimeType).toBe('image/webp');
  expect([...(out.images[0]?.bytes ?? [])]).toEqual([97, 98, 99]);
  expect(out.filteredCount).toBe(2);
  expect(out.costUsd).toBe(0.04);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://openrouter.ai/api/v1/images');
  expect(JSON.parse(init.body as string)).toEqual({ model: 'm/x', prompt: 'a cat', n: 2 });
});

it('a 200 carrying an error envelope throws with its message', async () => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(jsonResponse({ error: { code: 400, message: 'Prompt was refused' } })),
  );
  await expect(generateImages(req)).rejects.toThrow(/Prompt was refused/);
});

it('all candidates filtered is a loud failure, not an empty success', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({ data: [null, null] })));
  await expect(generateImages(req)).rejects.toThrow(/all 2 candidates were filtered/);
});

it('/images/models limits: n max, aspect ratios, missing n → 1, unlisted → loud 1', async () => {
  const fixture = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(fixture, { status: 200 })));
  const all = await listImageModelLimits('');
  expect(limitsFor(all, 'google/gemini-2.5-flash-image').maxCount).toBe(1);
  expect(limitsFor(all, 'openai/gpt-image-1')).toEqual({
    listed: true,
    maxCount: 10,
    aspectRatios: ['1:1', '3:2', '2:3', 'auto'],
  });
  expect(limitsFor(all, 'recraft/recraft-v3').maxCount).toBe(6);
  expect(limitsFor(all, 'krea/krea-2-medium').maxCount).toBe(1);
  expect(limitsFor(all, 'meta/muse-image')).toEqual({
    listed: true,
    maxCount: 1,
    aspectRatios: [],
  });
  expect(limitsFor(all, 'nobody/unlisted')).toEqual({
    listed: false,
    maxCount: 1,
    aspectRatios: [],
  });
});
