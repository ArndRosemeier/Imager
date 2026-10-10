import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { setImageTags } from '@/db/imageRepo';
import { updateSettings } from '@/db/settingsRepo';
import { listTagsInUse } from '@/db/tagRepo';
import { setVideoTags } from '@/db/videoRepo';
import type { StoredImage } from '@/domain/image';
import type { StoredVideo } from '@/domain/video';
import { VideosArea } from '@/features/videos/VideosArea';
import { resetVideoModelCache } from '@/llm/video';
import { jsonResponse } from '../helpers';

/**
 * Videos share the image tags (docs/17 row 59): one vocabulary, one rule
 * (`normalizeTags`), the same editor and the same filter bar.
 */
const modelsJson = readFileSync('tests/fixtures/video-models.json', 'utf8');

function video(id: string, prompt: string, tags: string[], createdAt: number): StoredVideo {
  return {
    id,
    bytes: new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    mimeType: 'video/mp4',
    request: {
      model: 'google/veo-3.1',
      prompt,
      duration: null,
      resolution: null,
      aspectRatio: null,
      generateAudio: null,
      firstFrameImageId: null,
      lastFrameImageId: null,
    },
    costUsd: null,
    createdAt,
    tags,
  };
}

const IMAGE: StoredImage = {
  id: 'img-1',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mimeType: 'image/png',
  width: 10,
  height: 10,
  prompt: 'an orc',
  model: 'm/x',
  source: 'generated',
  createdAt: 1,
  runId: 'r',
  favorite: false,
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
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', (url: string) =>
    url.endsWith('/videos/models')
      ? Promise.resolve(new Response(modelsJson))
      : Promise.resolve(jsonResponse({ status: 'in_progress' })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the tags in use are ONE vocabulary across images and videos, normalized the same way', async () => {
  await db.images.put(IMAGE);
  await db.videos.put(video('v-1', 'a fox', [], 2));
  await setImageTags('img-1', ['Orc', 'forest']);
  await setVideoTags('v-1', ['  ORC ', 'Snow  Storm']);
  await expect(db.videos.get('v-1')).resolves.toMatchObject({ tags: ['orc', 'snow storm'] });
  await expect(listTagsInUse()).resolves.toEqual(['forest', 'orc', 'snow storm']);
});

it('a video is tagged with the shared editor (image tags suggested) and filtered by the shared bar', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'google/veo-3.1' });
  await db.images.put({ ...IMAGE, tags: ['orc'] });
  await db.videos.bulkPut([video('v-1', 'a fox', ['snow'], 1), video('v-2', 'a march', [], 2)]);
  render(<VideosArea pollIntervalMs={60_000} />);
  const user = userEvent.setup();

  const march = (await screen.findByText('a march')).closest('li');
  if (march === null) throw new Error('no card');
  // The image's tag is offered on a video: one vocabulary.
  await user.click(within(march).getByRole('button', { name: 'Add tag orc' }));
  await waitFor(async () => {
    await expect(db.videos.get('v-2')).resolves.toMatchObject({ tags: ['orc'] });
  });

  // The bar lists the VIDEOS' tags with video counts, and filters the list.
  const orc = await screen.findByRole('button', { name: 'orc (1 video)' });
  await user.click(orc);
  expect(screen.queryByText('a fox')).toBeNull();
  expect(screen.getByText('a march')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Clear tags' }));
  expect(screen.getByText('a fox')).toBeInTheDocument();
});
