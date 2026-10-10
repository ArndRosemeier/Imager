import { strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { getSettings } from '@/db/settingsRepo';
import type { StoredClip } from '@/domain/clip';
import { DEFAULT_SETTINGS, type Settings } from '@/domain/settings';
import {
  buildBackupArchive,
  libraryStats,
  type ExportSource,
} from '@/features/export/exportLibrary';
import { applyImport, previewImport, readLibraryArchive } from '@/features/import/importLibrary';

/**
 * docs/17 row 60 — sound and voice clips in the backup ZIP, save AND restore,
 * through the app's OWN exporter and importer.
 */
const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  openRouterApiKey: 'sk-or-v1-SENTINEL-clips',
  soundModel: 'bytedance-seed/seed-audio-1-0',
  voiceModel: 'elevenlabs/eleven-v4',
};

const VOICE: StoredClip = {
  id: 'clip-1',
  kind: 'voice',
  bytes: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 7, 7]),
  mimeType: 'audio/mpeg',
  request: { model: 'elevenlabs/eleven-v4', text: 'Hello', voice: 'george', instructions: null },
  generationId: 'gen-1',
  createdAt: 1_700_000_000_000,
  tags: ['narrator'],
};

const SOUND: StoredClip = {
  ...VOICE,
  id: 'clip-2',
  kind: 'sound',
  request: { model: 'bytedance-seed/seed-audio-1-0', text: 'A door creaks', voice: null, instructions: null },
  generationId: null,
  tags: [],
};

const SOURCE: ExportSource = {
  images: [],
  runs: [],
  conversations: [],
  songs: [],
  musicSessions: [],
  videos: [],
  clips: [VOICE, SOUND],
  settings: SETTINGS,
};

const NOW = new Date('2026-10-10T10:00:00.000Z');

beforeEach(async () => {
  await Promise.all([db.settings.clear(), db.clips.clear()]);
});

it('clips round-trip byte-identical with their kind and request, and both picks are applied', async () => {
  const bytes = (await buildBackupArchive(SOURCE, NOW)).bytes;
  const entries = unzipSync(bytes);
  expect([...(entries['clips/clip-1.mp3'] ?? [])]).toEqual([...VOICE.bytes]);
  expect(strFromU8(bytes)).not.toContain('SENTINEL');

  const validated = await readLibraryArchive(bytes);
  await expect(previewImport(validated)).resolves.toMatchObject({
    clips: { incoming: 2, fresh: 2, existing: 0 },
  });
  const result = await applyImport(validated, { conflict: 'Keep both', settings: 'Apply settings' });
  expect(result.clips).toEqual({ added: 2, replaced: 0, skipped: 0 });
  const { bytes: _bytes, ...meta } = VOICE;
  expect(await db.clips.get('clip-1')).toMatchObject(meta);
  expect(await db.clips.get('clip-2')).toMatchObject({ kind: 'sound' });
  const settings = await getSettings();
  expect(settings.soundModel).toBe('bytedance-seed/seed-audio-1-0');
  expect(settings.voiceModel).toBe('elevenlabs/eleven-v4');
});

it('a tampered clip is a loud import failure that writes nothing', async () => {
  const entries = unzipSync((await buildBackupArchive(SOURCE, NOW)).bytes);
  const files: Zippable = {};
  for (const [name, data] of Object.entries(entries)) files[name] = data;
  files['clips/clip-1.mp3'] = new Uint8Array([...VOICE.bytes].map((b) => b ^ 1));
  await expect(readLibraryArchive(zipSync(files))).rejects.toThrow(/Clip "clip-1".*integrity/);
  await expect(db.clips.count()).resolves.toBe(0);
});

it('an archive written before clips imports as "no clips" and keeps the live picks', async () => {
  const entries = unzipSync((await buildBackupArchive({ ...SOURCE, clips: [] }, NOW)).bytes);
  const manifest = JSON.parse(strFromU8(entries['manifest.json'] ?? new Uint8Array())) as Record<
    string,
    unknown
  > & { settings: Record<string, unknown>; layout: Record<string, unknown> };
  delete manifest.clips;
  delete manifest.settings.soundModel;
  delete manifest.settings.voiceModel;
  delete manifest.layout.clips;
  const old = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) });

  await db.settings.put({ ...SETTINGS, voiceModel: 'live/pick', id: 'settings' });
  const result = await applyImport(await readLibraryArchive(old), {
    conflict: 'Keep both',
    settings: 'Apply settings',
  });
  expect(result.clips).toEqual({ added: 0, replaced: 0, skipped: 0 });
  expect((await getSettings()).voiceModel).toBe('live/pick');
});

it('the Save-your-work counts include the clips and their bytes', async () => {
  await db.clips.bulkPut([VOICE, SOUND]);
  await expect(libraryStats()).resolves.toMatchObject({
    clipCount: 2,
    clipBytes: VOICE.bytes.length * 2,
  });
});
