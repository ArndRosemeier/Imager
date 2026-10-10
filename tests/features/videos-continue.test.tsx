import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import type { StoredVideo } from '@/domain/video';
import { VideosArea } from '@/features/videos/VideosArea';
import { resetVideoModelCache } from '@/llm/video';
import { jsonResponse } from '../helpers';

/**
 * "Continue this video" (docs/17 row 58). jsdom decodes no video, so the frame
 * grab itself (`lastFrameOf`, a browser media + canvas call) is replaced here;
 * what is pinned is the wiring: the frame lands in the gallery, is staged as
 * the start image, and is sent as `first_frame`.
 */
const FRAME = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 42]);
vi.mock('@/features/videos/lastFrame', () => ({
  lastFrameOf: vi.fn(() => Promise.resolve({ bytes: new Uint8Array(FRAME), mimeType: 'image/png' })),
}));

const modelsJson = readFileSync('tests/fixtures/video-models.json', 'utf8');
let submits: Record<string, unknown>[] = [];

const VIDEO: StoredVideo = {
  id: 'job-1',
  bytes: new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
  mimeType: 'video/mp4',
  request: {
    model: 'google/veo-3.1',
    prompt: 'A fox in the snow',
    duration: null,
    resolution: null,
    aspectRatio: null,
    generateAudio: null,
    firstFrameImageId: null,
    lastFrameImageId: null,
  },
  costUsd: 1,
  createdAt: 1,
  tags: [],
};

beforeEach(async () => {
  resetVideoModelCache();
  await Promise.all([
    db.settings.clear(),
    db.videos.clear(),
    db.videoJobs.clear(),
    db.images.clear(),
  ]);
  submits = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 64, height: 36, close: () => undefined }),
  );
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/videos/models')) return Promise.resolve(new Response(modelsJson));
    if (url.endsWith('/videos') && init?.method === 'POST') {
      submits.push(JSON.parse(typeof init.body === 'string' ? init.body : '') as Record<string, unknown>);
      return Promise.resolve(jsonResponse({ id: 'job-2', status: 'pending' }, 202));
    }
    return Promise.resolve(jsonResponse({ status: 'in_progress' }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the last frame goes to the gallery, becomes the start image, and is sent as first_frame', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'google/veo-3.1' });
  await db.videos.put(VIDEO);
  render(<VideosArea pollIntervalMs={60_000} />);
  const user = userEvent.setup();

  const videos = await screen.findByRole('region', { name: 'Videos' });
  await user.click(await within(videos).findByRole('button', { name: 'Continue this video' }));

  expect(await screen.findByAltText('start image: Last frame of: A fox in the snow')).toBeInTheDocument();
  const stored = await db.images.toArray();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ prompt: 'Last frame of: A fox in the snow', source: 'uploaded' });

  await user.type(screen.getByLabelText('Prompt'), 'The fox jumps into the river');
  await user.click(screen.getByRole('button', { name: 'Generate video' }));
  await waitFor(() => {
    expect(submits).toHaveLength(1);
  });
  expect(submits[0]?.frame_images).toEqual([
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${btoa(String.fromCharCode(...FRAME))}` },
      frame_type: 'first_frame',
    },
  ]);
});

it('a model that takes no start image cannot continue a video, and says why', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'alibaba/wan-2.7' });
  await db.videos.put(VIDEO);
  render(<VideosArea pollIntervalMs={60_000} />);
  const button = await screen.findByRole('button', { name: 'Continue this video' });
  expect(button).toBeDisabled();
  expect(
    screen.getByText('Alibaba: Wan 2.7 takes no start image, so it cannot continue a video.'),
  ).toBeInTheDocument();
});
