import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OpenRouterError } from '@/llm/errors';
import {
  acceptsFirstFrame,
  acceptsLastFrame,
  canGenerateVideoAudio,
  downloadVideo,
  listVideoModels,
  pollVideo,
  resetVideoModelCache,
  submitVideo,
} from '@/llm/video';
import { jsonResponse } from '../helpers';

const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

interface Call {
  url: string;
  init: RequestInit | undefined;
}
let calls: Call[] = [];

function bodyOf(call: Call | undefined): string {
  const body = call?.init?.body;
  return typeof body === 'string' ? body : '';
}

function answer(response: () => Response): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response());
  });
}

beforeEach(() => {
  calls = [];
  resetVideoModelCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('lists the video models from GET /videos/models with their limits', async () => {
  answer(() => new Response(readFileSync('tests/fixtures/video-models.json', 'utf8')));
  const models = await listVideoModels('sk');
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/videos/models');
  expect(models.map((m) => m.id)).toEqual(['google/veo-3.1', 'alibaba/wan-2.7']);
  const [veo, wan] = models;
  expect(veo !== undefined && acceptsFirstFrame(veo) && acceptsLastFrame(veo)).toBe(true);
  expect(veo !== undefined && canGenerateVideoAudio(veo)).toBe(true);
  expect(wan !== undefined && (acceptsFirstFrame(wan) || acceptsLastFrame(wan) || canGenerateVideoAudio(wan))).toBe(false);
});

it('submits ONLY the options that were set, and the start/end images as frame images', async () => {
  answer(() => jsonResponse({ id: 'job-1', polling_url: 'x', status: 'pending' }, 202));
  await expect(
    submitVideo({
      apiKey: 'sk',
      model: 'google/veo-3.1',
      prompt: 'a fox',
      duration: 6,
      resolution: null,
      aspectRatio: '16:9',
      generateAudio: false,
      firstFrameDataUrl: 'data:image/png;base64,AAAA',
      lastFrameDataUrl: 'data:image/png;base64,BBBB',
    }),
  ).resolves.toBe('job-1');
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/videos');
  expect(JSON.parse(bodyOf(calls[0]))).toEqual({
    model: 'google/veo-3.1',
    prompt: 'a fox',
    duration: 6,
    aspect_ratio: '16:9',
    generate_audio: false,
    frame_images: [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA' },
        frame_type: 'first_frame',
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,BBBB' },
        frame_type: 'last_frame',
      },
    ],
  });

  calls = [];
  await submitVideo({
    apiKey: 'sk',
    model: 'alibaba/wan-2.7',
    prompt: 'rain',
    duration: null,
    resolution: null,
    aspectRatio: null,
    generateAudio: null,
    firstFrameDataUrl: null,
    lastFrameDataUrl: null,
  });
  expect(JSON.parse(bodyOf(calls[0]))).toEqual({ model: 'alibaba/wan-2.7', prompt: 'rain' });

  // An end image alone is sent alone.
  calls = [];
  await submitVideo({
    apiKey: 'sk',
    model: 'google/veo-3.1',
    prompt: 'land here',
    duration: null,
    resolution: null,
    aspectRatio: null,
    generateAudio: null,
    firstFrameDataUrl: null,
    lastFrameDataUrl: 'data:image/png;base64,CCCC',
  });
  expect(JSON.parse(bodyOf(calls[0]))).toMatchObject({
    frame_images: [{ image_url: { url: 'data:image/png;base64,CCCC' }, frame_type: 'last_frame' }],
  });
});

it('reads each job status, and never takes an unknown one for "still working"', async () => {
  answer(() => jsonResponse({ id: 'job-1', status: 'in_progress' }));
  await expect(pollVideo('sk', 'job-1')).resolves.toEqual({ kind: 'active', status: 'in_progress' });
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/videos/job-1');

  answer(() =>
    jsonResponse({ id: 'job-1', status: 'completed', unsigned_urls: ['u'], usage: { cost: 0.5 } }),
  );
  await expect(pollVideo('sk', 'job-1')).resolves.toEqual({ kind: 'completed', costUsd: 0.5 });

  answer(() => jsonResponse({ id: 'job-1', status: 'failed', error: 'content policy' }));
  await expect(pollVideo('sk', 'job-1')).resolves.toEqual({
    kind: 'failed',
    error: 'The video job failed: content policy',
  });

  answer(() => jsonResponse({ id: 'job-1', status: 'expired' }));
  await expect(pollVideo('sk', 'job-1')).resolves.toMatchObject({ kind: 'failed' });

  answer(() => jsonResponse({ id: 'job-1', status: 'teleporting' }));
  await expect(pollVideo('sk', 'job-1')).rejects.toThrow(/unknown status "teleporting"/);
});

it('downloads the content with the key and types it by its bytes; empty is loud', async () => {
  answer(() => new Response(MP4));
  await expect(downloadVideo('sk', 'job-1')).resolves.toMatchObject({ mimeType: 'video/mp4' });
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/videos/job-1/content?index=0');
  expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk');

  answer(() => new Response(new Uint8Array()));
  await expect(downloadVideo('sk', 'job-1')).rejects.toBeInstanceOf(OpenRouterError);
});
