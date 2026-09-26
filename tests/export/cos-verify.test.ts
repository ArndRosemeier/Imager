/**
 * DISPATCHER's own verification of docs/17 row 25 (the export format) — NOT
 * the writer's test. Built from the app's own exporter with a sentinel key, so
 * the key-absence claim is checked by the actor who relies on it.
 */
import { strFromU8, unzipSync } from 'fflate';
import { expect, it } from 'vitest';

import type { StoredImage } from '@/domain/image';
import type { Settings } from '@/domain/settings';
import {
  buildBackupArchive,
  buildImagesArchive,
  type ExportSource,
} from '@/features/export/exportLibrary';

const SENTINEL = 'sk-or-v1-COS-SENTINEL-77aa-DO-NOT-EXPORT';

function image(id: string, prompt: string, filler: number): StoredImage {
  return {
    id,
    bytes: new Uint8Array([filler, filler + 1, filler + 2]),
    mimeType: 'image/png',
    width: 8,
    height: 8,
    prompt,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 1700000000000,
    runId: '',
  };
}

const settings: Settings = {
  openRouterApiKey: SENTINEL,
  imageModel: 'google/gemini-2.5-flash-image',
  refineChatModel: 'openai/gpt-5-image',
};

const source: ExportSource = {
  images: [image('cos-1', 'a quiet harbour at dawn', 1), image('cos-2', 'a fox on a log', 90)],
  runs: [],
  conversations: [],
  settings,
};

/** Every byte of every entry, plus the raw archive, as one searchable string. */
function entryTexts(archive: Uint8Array): { name: string; text: string }[] {
  const entries = unzipSync(archive);
  return Object.entries(entries).map(([name, bytes]) => ({
    name,
    text: strFromU8(bytes, true),
  }));
}

it('COS: the sentinel key is nowhere in the backup archive (manifest, entries, raw bytes)', async () => {
  const archive = await buildBackupArchive(source, new Date('2026-09-26T09:00:00.000Z'));

  // 1. Raw archive bytes must not contain the secret.
  expect(strFromU8(archive.bytes, true).includes(SENTINEL)).toBe(false);

  // 2. No entry may contain it either (the manifest is the risky one).
  for (const entry of entryTexts(archive.bytes)) {
    expect(entry.text.includes(SENTINEL), `entry ${entry.name} leaked the key`).toBe(false);
  }

  // 3. The settings the archive DOES carry are exactly the non-secret ones.
  const manifest = JSON.parse(strFromU8(unzipSync(archive.bytes)['manifest.json'] ?? new Uint8Array())) as {
    settings: Record<string, unknown>;
  };
  expect(Object.keys(manifest.settings).sort()).toEqual(['imageModel', 'refineChatModel']);
});

it('COS: mode A is images only, with the stored bytes intact and the right extension', async () => {
  const archive = await buildImagesArchive(source.images, new Date('2026-09-26T09:00:00.000Z'));
  const entries = unzipSync(archive.bytes);
  const names = Object.keys(entries);
  expect(names).toHaveLength(2);
  expect(names.every((name) => !name.endsWith('.json'))).toBe(true);
  expect(names.every((name) => name.endsWith('.png'))).toBe(true);
  // Byte-identical to what was stored (not re-encoded).
  expect([...(entries[names[0] ?? ''] ?? [])]).toEqual([1, 2, 3]);
});
