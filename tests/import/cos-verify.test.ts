/**
 * DISPATCHER's own verification of docs/17 row 27 (the import seam) — built
 * independently of the writer's suite, from the app's OWN exporter.
 *
 * The claim worth a second reader: a settings restore must not touch the live
 * OpenRouter key, and a tampered or lying archive must write NOTHING.
 */
import { unzipSync, zipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import type { StoredImage } from '@/domain/image';
import { buildBackupArchive, type ExportSource } from '@/features/export/exportLibrary';
import { applyImport, readLibraryArchive } from '@/features/import/importLibrary';

const KEY_SENTINEL = 'sk-or-v1-COS-IMPORT-SENTINEL-b31f-DO-NOT-EXPORT';

function image(id: string, byte: number): StoredImage {
  return {
    id,
    bytes: new Uint8Array([byte, byte, byte]),
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: `cos ${id}`,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 1700000000000,
    runId: '',
    favorite: false,
    tags: [],
  };
}

const SOURCE: ExportSource = {
  images: [image('cos-a', 7), image('cos-b', 9)],
  runs: [],
  conversations: [],
  settings: {
    openRouterApiKey: 'IGNORED-NEVER-EXPORTED',
    imageModel: 'archived/image-model',
    refineChatModel: 'archived/refine-model',
  },
};

/**
 * fflate's types are `Uint8Array<ArrayBufferLike>` while the app's seams require
 * `Uint8Array<ArrayBuffer>`; an actual copy gives a real ArrayBuffer-backed
 * view (a cast would hide a genuine SharedArrayBuffer case).
 */
function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function freshArchive(): Promise<Uint8Array<ArrayBuffer>> {
  const archive = await buildBackupArchive(SOURCE, new Date('2026-09-26T10:00:00.000Z'));
  return toArrayBufferBytes(archive.bytes);
}

beforeEach(async () => {
  await Promise.all([db.settings.clear(), db.images.clear(), db.runs.clear(), db.conversations.clear()]);
});

it('COS: "Apply settings" restores the archive models and leaves the LIVE key untouched', async () => {
  await updateSettings({ openRouterApiKey: KEY_SENTINEL, imageModel: 'live/keep', refineChatModel: 'live/keep2' });
  const archive = await freshArchive();

  const validated = await readLibraryArchive(archive);
  await applyImport(validated, { conflict: 'Keep both', settings: 'Apply settings' });

  const after = await getSettings();
  // The archived model picks land…
  expect(after.imageModel).toBe('archived/image-model');
  expect(after.refineChatModel).toBe('archived/refine-model');
  // …and the key the archive never carried is EXACTLY what it was.
  expect(after.openRouterApiKey).toBe(KEY_SENTINEL);
});

it('COS: "Keep my settings" changes no model pick and still leaves the key untouched', async () => {
  await updateSettings({ openRouterApiKey: KEY_SENTINEL, imageModel: 'live/keep', refineChatModel: 'live/keep2' });
  const archive = await freshArchive();

  const validated = await readLibraryArchive(archive);
  await applyImport(validated, { conflict: 'Keep both', settings: 'Keep my settings' });

  const after = await getSettings();
  expect(after.imageModel).toBe('live/keep');
  expect(after.refineChatModel).toBe('live/keep2');
  expect(after.openRouterApiKey).toBe(KEY_SENTINEL);
});

it('COS: a TAMPERED image byte is refused loudly and writes nothing', async () => {
  const good = await freshArchive();
  const files: Zippable = unzipSync(good);
  const imageEntry = Object.keys(files).find((name) => name.startsWith('images/'));
  expect(imageEntry).toBeDefined();
  // An entry from an archive the app just built is raw bytes; appending one
  // byte makes the stored sha256 mismatch.
  const originalBytes = toArrayBufferBytes(unzipSync(good)[imageEntry ?? ''] ?? new Uint8Array());
  const tampered = new Uint8Array([...originalBytes, 0xff]);
  const rebuilt = toArrayBufferBytes(zipSync({ ...files, [imageEntry ?? '']: tampered }));

  await expect(readLibraryArchive(rebuilt)).rejects.toThrow();

  // Nothing from the bad archive may have landed.
  await expect(db.images.count()).resolves.toBe(0);
  const settings = await getSettings();
  expect(settings.openRouterApiKey).toBe('');
});

it('COS: a hand-edited manifest that re-adds the API key is refused', async () => {
  const good = await freshArchive();
  const files = unzipSync(good);
  const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as Record<string, unknown>;
  // Smuggle the secret back in, exactly as a careless editor would.
  manifest.settings = { ...(manifest.settings as object), openRouterApiKey: KEY_SENTINEL };
  const rebuilt = toArrayBufferBytes(
    zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) }),
  );

  await expect(readLibraryArchive(rebuilt)).rejects.toThrow();
  await expect(db.images.count()).resolves.toBe(0);
});
