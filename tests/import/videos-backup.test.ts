import { strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { getSettings } from '@/db/settingsRepo';
import { DEFAULT_SETTINGS, type Settings } from '@/domain/settings';
import type { StoredVideo } from '@/domain/video';
import {
  buildBackupArchive,
  libraryStats,
  type ExportSource,
} from '@/features/export/exportLibrary';
import { applyImport, previewImport, readLibraryArchive } from '@/features/import/importLibrary';

/**
 * docs/17 row 56 — finished videos in the backup ZIP, save AND restore,
 * through the app's OWN exporter and importer.
 */
const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  openRouterApiKey: 'sk-or-v1-SENTINEL-videos',
  videoModel: 'google/veo-3.1',
};

const VIDEO: StoredVideo = {
  id: 'job-1',
  bytes: new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 5, 5]),
  mimeType: 'video/mp4',
  request: {
    model: 'google/veo-3.1',
    prompt: 'A fox in the snow',
    duration: 6,
    resolution: null,
    aspectRatio: '16:9',
    generateAudio: true,
    firstFrameImageId: null,
    lastFrameImageId: null,
  },
  costUsd: 2.4,
  createdAt: 1_700_000_000_000,
  tags: ['fox', 'snow'],
};

const SOURCE: ExportSource = {
  images: [],
  runs: [],
  conversations: [],
  songs: [],
  musicSessions: [],
  videos: [VIDEO],
  settings: SETTINGS,
};

const NOW = new Date('2026-10-10T10:00:00.000Z');

beforeEach(async () => {
  await Promise.all([db.settings.clear(), db.videos.clear(), db.videoJobs.clear()]);
});

it('a video round-trips byte-identical with its request, and the video pick is applied', async () => {
  const bytes = (await buildBackupArchive(SOURCE, NOW)).bytes;
  const entries = unzipSync(bytes);
  expect([...(entries['videos/job-1.mp4'] ?? [])]).toEqual([...VIDEO.bytes]);
  expect(strFromU8(bytes)).not.toContain('SENTINEL');

  const validated = await readLibraryArchive(bytes);
  await expect(previewImport(validated)).resolves.toMatchObject({
    videos: { incoming: 1, fresh: 1, existing: 0 },
  });
  const result = await applyImport(validated, { conflict: 'Keep both', settings: 'Apply settings' });
  expect(result.videos).toEqual({ added: 1, replaced: 0, skipped: 0 });
  const stored = await db.videos.get('job-1');
  const { bytes: _bytes, ...meta } = VIDEO;
  expect(stored).toMatchObject(meta);
  expect([...(stored?.bytes ?? [])]).toEqual([...VIDEO.bytes]);
  expect((await getSettings()).videoModel).toBe('google/veo-3.1');
});

it('a tampered video is a loud import failure that writes nothing', async () => {
  const entries = unzipSync((await buildBackupArchive(SOURCE, NOW)).bytes);
  const files: Zippable = {};
  for (const [name, data] of Object.entries(entries)) files[name] = data;
  files['videos/job-1.mp4'] = new Uint8Array([...VIDEO.bytes].map((b) => b ^ 1));
  await expect(readLibraryArchive(zipSync(files))).rejects.toThrow(/Video "job-1".*integrity/);
  await expect(db.videos.count()).resolves.toBe(0);
});

it('an archive written before videos imports as "no videos" and keeps the live video pick', async () => {
  const entries = unzipSync((await buildBackupArchive({ ...SOURCE, videos: [] }, NOW)).bytes);
  const manifest = JSON.parse(strFromU8(entries['manifest.json'] ?? new Uint8Array())) as Record<
    string,
    unknown
  > & { settings: Record<string, unknown>; layout: Record<string, unknown> };
  delete manifest.videos;
  // (A pre-tags video entry is covered by `tags` defaulting to [] in the schema.)
  delete manifest.settings.videoModel;
  delete manifest.layout.videos;
  const old = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) });

  await db.settings.put({ ...SETTINGS, videoModel: 'live/pick', id: 'settings' });
  const result = await applyImport(await readLibraryArchive(old), {
    conflict: 'Keep both',
    settings: 'Apply settings',
  });
  expect(result.videos).toEqual({ added: 0, replaced: 0, skipped: 0 });
  expect((await getSettings()).videoModel).toBe('live/pick');
});

it('the Save-your-work counts include the videos and their bytes', async () => {
  await db.videos.put(VIDEO);
  await expect(libraryStats()).resolves.toMatchObject({
    videoCount: 1,
    videoBytes: VIDEO.bytes.length,
  });
});
