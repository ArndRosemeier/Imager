import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import type { VideoJob } from '@/domain/video';
import { VideosArea } from '@/features/videos/VideosArea';
import { resetVideoModelCache } from '@/llm/video';
import { jsonResponse } from '../helpers';

/**
 * The Videos tab end to end (docs/17 row 56): submit → the job is STORED at
 * once → polled → downloaded → a playable, downloadable, deletable video. The
 * model list is `tests/fixtures/video-models.json`, reconstructed from
 * OpenRouter's video-generation guide.
 */
const modelsJson = readFileSync('tests/fixtures/video-models.json', 'utf8');
const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2]);

let submits: Record<string, unknown>[] = [];
let polls: (() => Response)[] = [];
let downloads = 0;

function stubFetch(): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/videos/models')) return Promise.resolve(new Response(modelsJson));
    if (url.endsWith('/videos') && init?.method === 'POST') {
      submits.push(JSON.parse(typeof init.body === 'string' ? init.body : '') as Record<string, unknown>);
      return Promise.resolve(jsonResponse({ id: `job-${String(submits.length)}`, status: 'pending' }, 202));
    }
    if (url.includes('/content?index=0')) {
      downloads += 1;
      return Promise.resolve(new Response(MP4));
    }
    if (/\/videos\/job-\d+$/.test(url)) {
      const next = polls.shift();
      if (next === undefined) return Promise.resolve(jsonResponse({ status: 'in_progress' }));
      return Promise.resolve(next());
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

beforeEach(async () => {
  resetVideoModelCache();
  await Promise.all([db.settings.clear(), db.videos.clear(), db.videoJobs.clear()]);
  submits = [];
  polls = [];
  downloads = 0;
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('a video is submitted with the chosen options, stored as a job, polled, downloaded and deletable', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'google/veo-3.1' });
  polls.push(() => jsonResponse({ status: 'completed', unsigned_urls: ['u'], usage: { cost: 2.4 } }));
  render(<VideosArea pollIntervalMs={20} />);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Prompt'), 'A fox in the snow');
  // The model's own limits are the choices; "Model default" sends nothing.
  await user.selectOptions(screen.getByLabelText('Length'), '6');
  await user.selectOptions(screen.getByLabelText('Aspect ratio'), '9:16');
  await user.click(screen.getByLabelText('Generate audio with the video'));
  await user.click(screen.getByRole('button', { name: 'Generate video' }));

  await waitFor(() => {
    expect(submits).toHaveLength(1);
  });
  expect(submits[0]).toEqual({
    model: 'google/veo-3.1',
    prompt: 'A fox in the snow',
    duration: 6,
    aspect_ratio: '9:16',
    generate_audio: false,
  });

  // Polled, downloaded, turned into a video in one step: the job is gone.
  const videos = await screen.findByRole('region', { name: 'Videos' });
  expect(await within(videos).findByLabelText('Play: A fox in the snow')).toBeInTheDocument();
  expect(downloads).toBe(1);
  expect(within(videos).getByText(/\$2\.4000/)).toBeInTheDocument();
  await expect(db.videoJobs.count()).resolves.toBe(0);
  await expect(db.videos.get('job-1')).resolves.toMatchObject({ mimeType: 'video/mp4' });

  // Delete asks first; "Keep it" deletes nothing.
  await user.click(within(videos).getByRole('button', { name: 'Delete' }));
  await user.click(within(videos).getByRole('button', { name: 'Keep it' }));
  await expect(db.videos.count()).resolves.toBe(1);
  await user.click(within(videos).getByRole('button', { name: 'Delete' }));
  await user.click(within(videos).getByRole('button', { name: 'Yes, delete' }));
  await waitFor(async () => {
    await expect(db.videos.count()).resolves.toBe(0);
  });
  expect(await screen.findByText('No videos yet.')).toBeInTheDocument();
});

it('a job stored earlier (a reload, a tab switch) is picked up and finished', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'google/veo-3.1' });
  const job: VideoJob = {
    id: 'job-7',
    request: {
      model: 'google/veo-3.1',
      prompt: 'Waves at dusk',
      duration: null,
      resolution: null,
      aspectRatio: null,
      generateAudio: null,
      firstFrameImageId: null,
    },
    status: 'in_progress',
    error: null,
    createdAt: 1,
  };
  await db.videoJobs.put(job);
  polls.push(() => jsonResponse({ status: 'completed', usage: { cost: 1 } }));
  render(<VideosArea pollIntervalMs={20} />);
  expect(await screen.findByLabelText('Play: Waves at dusk')).toBeInTheDocument();
});

function storedJob(id: string, status: VideoJob['status']): VideoJob {
  return {
    id,
    request: {
      model: 'google/veo-3.1',
      prompt: 'A storm',
      duration: 4,
      resolution: '720p',
      aspectRatio: null,
      generateAudio: true,
      firstFrameImageId: null,
    },
    status,
    error: status === 'failed' ? 'earlier failure' : null,
    createdAt: 1,
  };
}

it('a failed job is SHOWN with its reason, and Check again polls it again', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'google/veo-3.1' });
  await db.videoJobs.put(storedJob('job-3', 'pending'));
  polls.push(() => jsonResponse({ status: 'failed', error: 'content policy' }));
  render(<VideosArea pollIntervalMs={20} />);
  const user = userEvent.setup();
  const jobs = await screen.findByRole('region', { name: 'Video jobs' });
  expect(
    await within(jobs).findByText('Failed: The video job failed: content policy'),
  ).toBeInTheDocument();

  // Check again: back to pending and polled again (this time still running).
  await user.click(within(jobs).getByRole('button', { name: 'Check again' }));
  expect(await within(jobs).findByText('Generating…')).toBeInTheDocument();
  await expect(db.videoJobs.get('job-3')).resolves.toMatchObject({ status: 'in_progress', error: null });
});

it('Dismiss removes a failed job', async () => {
  await updateSettings({ openRouterApiKey: 'sk', videoModel: 'google/veo-3.1' });
  await db.videoJobs.put(storedJob('job-4', 'failed'));
  render(<VideosArea pollIntervalMs={20} />);
  const user = userEvent.setup();
  expect(await screen.findByText('Failed: earlier failure')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(async () => {
    await expect(db.videoJobs.count()).resolves.toBe(0);
  });
  expect(screen.queryByRole('region', { name: 'Video jobs' })).toBeNull();
});

it('without a video model nothing can be generated, and the reason is shown', async () => {
  await updateSettings({ openRouterApiKey: 'sk' });
  render(<App initialTab="Videos" />);
  expect(
    await screen.findByText('No video model selected — pick one in Settings.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate video' })).toBeDisabled();
});
