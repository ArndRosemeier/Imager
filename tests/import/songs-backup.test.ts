import { strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { getSettings } from '@/db/settingsRepo';
import {
  EMPTY_SONG_SHEET,
  musicSessionSchema,
  type MusicSession,
  type StoredSong,
} from '@/domain/music';
import { DEFAULT_SETTINGS, type Settings } from '@/domain/settings';
import {
  buildBackupArchive,
  libraryStats,
  type ExportSource,
} from '@/features/export/exportLibrary';
import { applyImport, previewImport, readLibraryArchive } from '@/features/import/importLibrary';
import { sha256Hex } from '@/lib/sha256';

/**
 * docs/17 row 53 — songs and song chats in the backup ZIP, save AND restore.
 * The archives are built by the app's OWN exporter and read by its OWN
 * importer, so writer/reader drift shows up here.
 */

const KEY = 'sk-or-v1-SENTINEL-songs';
const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  openRouterApiKey: KEY,
  musicModel: 'google/lyria-3-pro-preview',
  songWriterModel: 'meta-llama/llama-3.3-70b-instruct',
};

const SHEET = { ...EMPTY_SONG_SHEET, title: 'Night Drive', style: 'synthwave', lyrics: '[Verse]\nla' };

const SONG: StoredSong = {
  id: 'song-1',
  sessionId: 'session-1',
  bytes: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 9, 9, 9]),
  mimeType: 'audio/mpeg',
  title: 'Night Drive',
  sheet: SHEET,
  prompt: 'Title: Night Drive\nStyle: synthwave',
  transcript: '[Verse]\nla',
  model: 'google/lyria-3-pro-preview',
  costUsd: 0.08,
  createdAt: 1_700_000_000_000,
};

const SESSION: MusicSession = musicSessionSchema.parse({
  id: 'session-1',
  title: 'Night Drive',
  sheet: SHEET,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  messages: [
    {
      id: 'm-1',
      role: 'user',
      action: 'message',
      text: 'a synthwave night drive',
      sheet: null,
      songId: '',
      writerModel: '',
      musicModel: '',
      writerCostUsd: null,
      renderCostUsd: null,
      error: null,
      createdAt: 1_700_000_000_000,
    },
    {
      id: 'm-2',
      role: 'assistant',
      action: 'message',
      text: 'Started it.',
      sheet: SHEET,
      songId: 'song-1',
      writerModel: 'meta-llama/llama-3.3-70b-instruct',
      musicModel: 'google/lyria-3-pro-preview',
      writerCostUsd: 0.001,
      renderCostUsd: 0.08,
      error: null,
      createdAt: 1_700_000_000_500,
    },
  ],
});

const SOURCE: ExportSource = {
  images: [],
  runs: [],
  conversations: [],
  songs: [SONG],
  musicSessions: [SESSION],
  videos: [],
  clips: [],
  settings: SETTINGS,
};

const NOW = new Date('2026-10-09T10:00:00.000Z');

async function archive(source: ExportSource = SOURCE): Promise<Uint8Array<ArrayBuffer>> {
  return (await buildBackupArchive(source, NOW)).bytes;
}

function rezip(entries: Record<string, Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  for (const [name, data] of Object.entries(entries)) files[name] = data;
  return zipSync(files);
}

function manifestOf(bytes: Uint8Array<ArrayBuffer>): Record<string, unknown> {
  const raw = unzipSync(bytes)['manifest.json'];
  if (raw === undefined) throw new Error('no manifest');
  return JSON.parse(strFromU8(raw)) as Record<string, unknown>;
}

beforeEach(async () => {
  await Promise.all([
    db.images.clear(),
    db.runs.clear(),
    db.conversations.clear(),
    db.songs.clear(),
    db.musicSessions.clear(),
    db.settings.clear(),
  ]);
});

it('the backup carries every song as raw bytes under songs/, with its integrity pair, and the song chats', async () => {
  const bytes = await archive();
  const entries = unzipSync(bytes);
  expect([...(entries['songs/song-1.mp3'] ?? [])]).toEqual([...SONG.bytes]);
  const manifest = manifestOf(bytes);
  expect(manifest.songs).toEqual([
    expect.objectContaining({
      id: 'song-1',
      fileName: 'songs/song-1.mp3',
      byteLength: SONG.bytes.length,
      sha256: await sha256Hex(SONG.bytes),
      sheet: SHEET,
      transcript: '[Verse]\nla',
    }),
  ]);
  expect(manifest.musicSessions).toEqual([SESSION]);
  expect(manifest.settings).toMatchObject({
    musicModel: SETTINGS.musicModel,
    songWriterModel: SETTINGS.songWriterModel,
  });
  // The key is still nowhere in the file.
  expect(strFromU8(entries['manifest.json'] ?? new Uint8Array())).not.toContain(KEY);
});

it('ROUND TRIP: an import rebuilds the songs byte-identical and the song chats verbatim', async () => {
  const validated = await readLibraryArchive(await archive());
  const preview = await previewImport(validated);
  expect(preview.songs).toEqual({ incoming: 1, fresh: 1, existing: 0 });
  expect(preview.musicSessions).toEqual({ incoming: 1, fresh: 1, existing: 0 });
  expect(preview.danglingSongIds).toEqual([]);

  const result = await applyImport(validated, { conflict: 'Keep both', settings: 'Apply settings' });
  expect(result.songs).toEqual({ added: 1, replaced: 0, skipped: 0 });
  expect(result.musicSessions).toEqual({ added: 1, replaced: 0, skipped: 0 });

  const [stored] = await db.songs.toArray();
  expect(stored).toMatchObject({ ...SONG, bytes: expect.anything() as unknown });
  expect([...(stored?.bytes ?? [])]).toEqual([...SONG.bytes]);
  await expect(db.musicSessions.get('session-1')).resolves.toEqual(SESSION);
  const settings = await getSettings();
  expect(settings.musicModel).toBe(SETTINGS.musicModel);
  expect(settings.songWriterModel).toBe(SETTINGS.songWriterModel);
});

it('a tampered song byte is a LOUD failure and writes nothing', async () => {
  const entries = unzipSync(await archive());
  const song = entries['songs/song-1.mp3'];
  if (song === undefined) throw new Error('seed');
  song[5] = 0;
  await expect(readLibraryArchive(rezip(entries))).rejects.toThrow(
    /Song "song-1" .*failed its integrity check/,
  );
  await expect(db.songs.count()).resolves.toBe(0);
});

it('a missing song entry is refused, naming it', async () => {
  const entries = unzipSync(await archive());
  delete entries['songs/song-1.mp3'];
  await expect(readLibraryArchive(rezip(entries))).rejects.toThrow(
    /song "song-1" names the entry "songs\/song-1.mp3"/,
  );
});

it('an archive written BEFORE the Music tab imports as "no music" and keeps the current music picks', async () => {
  const entries = unzipSync(await archive({ ...SOURCE, songs: [], musicSessions: [] }));
  const manifest = manifestOf(rezip(entries));
  delete manifest.songs;
  delete manifest.musicSessions;
  const settings = manifest.settings as Record<string, unknown>;
  delete settings.musicModel;
  delete settings.songWriterModel;
  delete (manifest.layout as Record<string, unknown>).songs;
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));

  await db.settings.put({ ...SETTINGS, id: 'settings' });
  const validated = await readLibraryArchive(rezip(entries));
  expect(validated.songs).toEqual([]);
  const result = await applyImport(validated, { conflict: 'Keep both', settings: 'Apply settings' });
  expect(result.songs).toEqual({ added: 0, replaced: 0, skipped: 0 });
  // "Apply settings" applied what the file recorded, and nothing it did not.
  const live = await getSettings();
  expect(live.musicModel).toBe(SETTINGS.musicModel);
  expect(live.songWriterModel).toBe(SETTINGS.songWriterModel);
  expect(live.openRouterApiKey).toBe(KEY);
});

it('"Keep both" leaves an existing song untouched; "Replace existing" takes the file version', async () => {
  await db.songs.put({ ...SONG, title: 'Local edit' });
  const validated = await readLibraryArchive(await archive());
  const kept = await applyImport(validated, { conflict: 'Keep both', settings: 'Keep my settings' });
  expect(kept.songs).toEqual({ added: 0, replaced: 0, skipped: 1 });
  await expect(db.songs.get('song-1')).resolves.toMatchObject({ title: 'Local edit' });

  const replaced = await applyImport(validated, {
    conflict: 'Replace existing',
    settings: 'Keep my settings',
  });
  expect(replaced.songs).toEqual({ added: 0, replaced: 1, skipped: 0 });
  await expect(db.songs.get('song-1')).resolves.toMatchObject({ title: 'Night Drive' });
});

it('the Save-your-work counts include the songs and their bytes', async () => {
  await db.songs.put(SONG);
  await db.musicSessions.put(SESSION);
  await expect(libraryStats()).resolves.toMatchObject({
    songCount: 1,
    songBytes: SONG.bytes.length,
    musicSessionCount: 1,
  });
});
