import { strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { conversationSchema, type ChatMessage, type Conversation } from '@/domain/chat';
import { runSchema, type Run, type StoredImage } from '@/domain/image';
import type { Settings } from '@/domain/settings';
import {
  buildBackupArchive,
  buildImagesArchive,
  type ExportSource,
} from '@/features/export/exportLibrary';
import {
  applyImport,
  previewImport,
  readLibraryArchive,
  type ConflictChoice,
  type SettingsChoice,
} from '@/features/import/importLibrary';

/**
 * docs/17 row 27 — the IMPORT seam, pinned without a browser.
 *
 * The owner asked for "load everything, just for internal format". What these
 * pins defend is what would make that dangerous: a reader that half-imports a
 * tampered file, a manifest that re-adds the OpenRouter key, a conflict choice
 * that quietly does the other thing, and — the one the whole slice is arranged
 * around — a settings restore that overwrites the live key with an empty one.
 *
 * The archives are built by the app's OWN exporter (`buildBackupArchive`), so a
 * writer/reader drift would show up here immediately.
 */

const KEY_SENTINEL = 'sk-or-v1-SENTINEL-9f3c-DO-NOT-EXPORT';

const SETTINGS: Settings = {
  openRouterApiKey: KEY_SENTINEL,
  imageModel: 'google/gemini-2.5-flash-image',
  refineChatModel: 'openai/gpt-5-image',
};

const RUN: Run = runSchema.parse({
  id: 'run-1',
  kind: 'refine',
  prompt: 'a red fox',
  model: 'google/gemini-2.5-flash-image',
  inputImageIds: ['image-a'],
  requestedCount: 2,
  receivedCount: 2,
  filteredCount: 0,
  costUsd: 0.0123,
  createdAt: 1_700_000_000_000,
  error: null,
});

const USER_MESSAGE: ChatMessage = {
  id: 'message-1',
  role: 'user',
  text: 'make the sky darker',
  imageIds: ['image-b'],
  runId: '',
  model: '',
  costUsd: null,
  error: null,
  createdAt: 1_700_000_000_000,
};

const CONVERSATION: Conversation = conversationSchema.parse({
  id: 'conversation-1',
  title: 'a red fox',
  model: 'openai/gpt-5-image',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  messages: [
    USER_MESSAGE,
    {
      id: 'message-2',
      role: 'assistant',
      text: 'done',
      imageIds: [],
      runId: 'run-1',
      model: 'openai/gpt-5-image',
      costUsd: 0.02,
      error: null,
      createdAt: 1_700_000_000_500,
    },
  ],
});

function image(overrides: Partial<StoredImage> & { id: string }): StoredImage {
  return {
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    mimeType: 'image/png',
    width: 64,
    height: 32,
    prompt: 'a red fox',
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 1_700_000_000_000,
    runId: 'run-1',
    favorite: false,
    ...overrides,
  };
}

const IMAGE_A = image({ id: 'image-a', bytes: new Uint8Array([9, 8, 7, 6]) });
// A FAVOURITE, so the round trip pins that the flag survives a backup (row 32).
const IMAGE_B = image({
  id: 'image-b',
  bytes: new Uint8Array([6, 5, 4]),
  mimeType: 'image/jpeg',
  favorite: true,
});

const SOURCE: ExportSource = {
  images: [IMAGE_A, IMAGE_B],
  runs: [RUN],
  conversations: [CONVERSATION],
  settings: SETTINGS,
};

const NOW = new Date('2026-09-26T10:00:00.000Z');

async function archiveBytes(source: ExportSource = SOURCE): Promise<Uint8Array<ArrayBuffer>> {
  return (await buildBackupArchive(source, NOW)).bytes;
}

/** Re-zip `entries`, so a test can present a legitimate archive with ONE edit. */
function rezip(entries: Record<string, Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  for (const [name, data] of Object.entries(entries)) files[name] = data;
  return zipSync(files);
}

/** A valid archive whose manifest has been edited by `mutate`. */
async function archiveWithManifestEdit(
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const entries = unzipSync(await archiveBytes());
  const raw = entries['manifest.json'];
  if (raw === undefined) throw new Error('seed: no manifest');
  const manifest = JSON.parse(strFromU8(raw)) as Record<string, unknown>;
  mutate(manifest);
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return rezip(entries);
}

async function seedSettings(settings: Settings): Promise<void> {
  await db.settings.put({ ...settings, id: 'settings' });
}

function choices(
  conflict: ConflictChoice = 'Keep both',
  settings: SettingsChoice = 'Apply settings',
): { conflict: ConflictChoice; settings: SettingsChoice } {
  return { conflict, settings };
}

beforeEach(async () => {
  await Promise.all([
    db.images.clear(),
    db.runs.clear(),
    db.conversations.clear(),
    db.settings.clear(),
  ]);
});

/* ------------------------------------------------------------- good archive */

it('ROUND TRIP: a good archive rebuilds every row, byte-identical, with its ids', async () => {
  const archive = await readLibraryArchive(await archiveBytes());

  // The preview, before anything is written, sees an empty library.
  const preview = await previewImport(archive);
  expect(preview.exportedAt).toBe(NOW.toISOString());
  expect(preview.settings).toEqual({
    imageModel: SETTINGS.imageModel,
    refineChatModel: SETTINGS.refineChatModel,
  });
  expect(preview.images).toEqual({ incoming: 2, fresh: 2, existing: 0 });
  expect(preview.runs).toEqual({ incoming: 1, fresh: 1, existing: 0 });
  expect(preview.conversations).toEqual({ incoming: 1, fresh: 1, existing: 0 });
  expect(preview.danglingImageIds).toEqual([]);
  // The preview wrote NOTHING.
  expect(await db.images.count()).toBe(0);

  const result = await applyImport(archive, choices());
  expect(result).toEqual({
    images: { added: 2, replaced: 0, skipped: 0 },
    runs: { added: 1, replaced: 0, skipped: 0 },
    conversations: { added: 1, replaced: 0, skipped: 0 },
    settingsApplied: true,
    danglingImageIds: [],
  });

  // Counts and ids: preserved, so a conversation's pointers still resolve.
  expect(await db.images.count()).toBe(2);
  expect(await db.runs.count()).toBe(1);
  expect(await db.conversations.count()).toBe(1);
  const storedA = await db.images.get('image-a');
  const storedB = await db.images.get('image-b');
  expect(Array.from(storedA?.bytes ?? new Uint8Array())).toEqual(Array.from(IMAGE_A.bytes));
  expect(Array.from(storedB?.bytes ?? new Uint8Array())).toEqual(Array.from(IMAGE_B.bytes));
  expect(storedA?.prompt).toBe(IMAGE_A.prompt);
  expect(storedB?.mimeType).toBe('image/jpeg');
  // The favourite flag is part of the row, so a backup preserves it (row 32).
  expect(storedA?.favorite).toBe(false);
  expect(storedB?.favorite).toBe(true);

  const storedRun = await db.runs.get('run-1');
  const storedConversation = await db.conversations.get('conversation-1');
  expect(storedRun).toEqual(RUN);
  expect(storedConversation).toEqual(CONVERSATION);
  const imageIds = new Set((await db.images.toArray()).map((row) => row.id));
  for (const id of storedRun?.inputImageIds ?? []) expect(imageIds.has(id)).toBe(true);
  for (const message of storedConversation?.messages ?? []) {
    for (const id of message.imageIds) expect(imageIds.has(id)).toBe(true);
  }
});

/* ----------------------------------------------------------- the key survives */

it('settings "Apply settings" writes the file settings and leaves the LIVE key exactly as it was', async () => {
  await seedSettings({ ...SETTINGS, imageModel: 'live/model-before', refineChatModel: '' });
  const archive = await readLibraryArchive(await archiveBytes());

  const result = await applyImport(archive, choices('Keep both', 'Apply settings'));
  expect(result.settingsApplied).toBe(true);

  const row = await db.settings.get('settings');
  expect(row?.openRouterApiKey).toBe(KEY_SENTINEL);
  expect(row?.imageModel).toBe(SETTINGS.imageModel);
  expect(row?.refineChatModel).toBe(SETTINGS.refineChatModel);
});

it('settings "Keep my settings" touches nothing at all, and the key is untouched either way', async () => {
  await seedSettings({ ...SETTINGS, imageModel: 'live/model-before', refineChatModel: 'live/refine' });
  const archive = await readLibraryArchive(await archiveBytes());

  const result = await applyImport(archive, choices('Keep both', 'Keep my settings'));
  expect(result.settingsApplied).toBe(false);

  const row = await db.settings.get('settings');
  expect(row).toEqual({
    id: 'settings',
    openRouterApiKey: KEY_SENTINEL,
    imageModel: 'live/model-before',
    refineChatModel: 'live/refine',
  });
});

it('an import into a database with NO settings row does not invent a key', async () => {
  const archive = await readLibraryArchive(await archiveBytes());
  await applyImport(archive, choices('Keep both', 'Apply settings'));
  expect((await db.settings.get('settings'))?.openRouterApiKey).toBe('');
});

/* ------------------------------------------------------------- loud refusals */

it('a tampered image byte is a LOUD failure and writes NOTHING', async () => {
  const entries = unzipSync(await archiveBytes());
  const entry = entries['images/image-a.png'];
  if (entry === undefined) throw new Error('seed: no image entry');
  entry[0] = (entry[0] ?? 0) ^ 0xff;
  const tampered = rezip(entries);

  await expect(readLibraryArchive(tampered)).rejects.toThrow(/integrity check/);
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/"image-a"/);
  expect(await db.images.count()).toBe(0);
  expect(await db.runs.count()).toBe(0);
  expect(await db.conversations.count()).toBe(0);
});

it('a manifest byteLength that disagrees with the entry is refused (no partial import)', async () => {
  const tampered = await archiveWithManifestEdit((manifest) => {
    const images = manifest.images as { byteLength: number }[];
    if (images[0] !== undefined) images[0].byteLength += 1;
  });
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/refusing a partial import/);
  expect(await db.images.count()).toBe(0);
});

it('a missing image entry is a loud failure naming the entry', async () => {
  const entries = unzipSync(await archiveBytes());
  delete entries['images/image-b.jpg'];
  await expect(readLibraryArchive(rezip(entries))).rejects.toThrow(/images\/image-b\.jpg/);
  expect(await db.images.count()).toBe(0);
});

it('a wrong format is refused by name', async () => {
  const tampered = await archiveWithManifestEdit((manifest) => {
    manifest.format = 'some-other-app';
  });
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/not an Imager library backup/);
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/some-other-app/);
});

it('a different version is refused, naming both versions', async () => {
  const tampered = await archiveWithManifestEdit((manifest) => {
    manifest.version = 2;
  });
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/version 2/);
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/version 1 only/);
});

it('a manifest that re-adds the OpenRouter key is refused (strictObject)', async () => {
  const tampered = await archiveWithManifestEdit((manifest) => {
    (manifest.settings as Record<string, unknown>).openRouterApiKey = KEY_SENTINEL;
  });
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/openRouterApiKey/);
  expect(await db.images.count()).toBe(0);
});

it('an unknown extra manifest field is refused rather than ignored', async () => {
  const tampered = await archiveWithManifestEdit((manifest) => {
    manifest.somethingNew = true;
  });
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/somethingNew/);
});

it('duplicate image ids in one manifest are refused (which bytes belong to which id?)', async () => {
  const tampered = await archiveWithManifestEdit((manifest) => {
    const images = manifest.images as unknown[];
    images.push(images[0]);
  });
  await expect(readLibraryArchive(tampered)).rejects.toThrow(/more than once/);
});

it('the images-only ZIP is refused with the reason (no manifest to import)', async () => {
  const imagesOnly = buildImagesArchive(SOURCE.images, NOW).bytes;
  await expect(readLibraryArchive(imagesOnly)).rejects.toThrow(/no manifest\.json/);
  expect(await db.images.count()).toBe(0);
});

it('a file that is not a ZIP at all is refused loudly', async () => {
  await expect(readLibraryArchive(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
    /not a readable ZIP archive/,
  );
});

/* ------------------------------------------------- an archive from BEFORE */

it('an archive exported BEFORE favourites existed imports as false, not a failure', async () => {
  /*
   * Exactly what a pre-favourites build wrote: no `favorite` key on any image
   * entry. The manifest is a `strictObject`, so the field's `.default(false)` is
   * the ONE thing standing between an old backup and a zod refusal — and the
   * reading it supplies ("not a favourite") is the meaning the absence already
   * had (docs/17 row 32).
   */
  const older = await archiveWithManifestEdit((manifest) => {
    const images = manifest.images as Record<string, unknown>[];
    for (const entry of images) delete entry.favorite;
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((entry) => !('favorite' in entry))).toBe(true);
  });

  const archive = await readLibraryArchive(older);
  expect(archive.manifest.images.every((meta) => !meta.favorite)).toBe(true);

  const result = await applyImport(archive, choices());
  expect(result.images).toEqual({ added: 2, replaced: 0, skipped: 0 });
  expect((await db.images.get('image-a'))?.favorite).toBe(false);
  expect((await db.images.get('image-b'))?.favorite).toBe(false);
});

/* --------------------------------------------------------- conflict choices */

async function seedLocalImage(overrides: Partial<StoredImage> & { id: string }): Promise<void> {
  await db.images.put(image(overrides));
}

it('"Keep both" leaves an existing row BYTE-UNCHANGED and adds only the new ids', async () => {
  await seedLocalImage({
    id: 'image-a',
    bytes: new Uint8Array([255, 254, 253]),
    prompt: 'LOCAL EDIT — must survive',
  });
  const archive = await readLibraryArchive(await archiveBytes());

  const preview = await previewImport(archive);
  expect(preview.images).toEqual({ incoming: 2, fresh: 1, existing: 1 });

  const result = await applyImport(archive, choices('Keep both'));
  expect(result.images).toEqual({ added: 1, replaced: 0, skipped: 1 });

  const kept = await db.images.get('image-a');
  expect(Array.from(kept?.bytes ?? new Uint8Array())).toEqual([255, 254, 253]);
  expect(kept?.prompt).toBe('LOCAL EDIT — must survive');
  // The new one landed with the archive's bytes.
  expect(Array.from((await db.images.get('image-b'))?.bytes ?? new Uint8Array())).toEqual(
    Array.from(IMAGE_B.bytes),
  );
});

it('"Replace existing" overwrites the existing row with the archive version', async () => {
  await seedLocalImage({
    id: 'image-a',
    bytes: new Uint8Array([255, 254, 253]),
    prompt: 'LOCAL EDIT — must be replaced',
  });
  const archive = await readLibraryArchive(await archiveBytes());

  const result = await applyImport(archive, choices('Replace existing'));
  expect(result.images).toEqual({ added: 1, replaced: 1, skipped: 0 });

  const replaced = await db.images.get('image-a');
  expect(Array.from(replaced?.bytes ?? new Uint8Array())).toEqual(Array.from(IMAGE_A.bytes));
  expect(replaced?.prompt).toBe(IMAGE_A.prompt);
});

it('the conflict choice applies to runs and conversations too', async () => {
  await db.runs.put({ ...RUN, prompt: 'LOCAL EDIT — must survive' });
  await db.conversations.put({ ...CONVERSATION, title: 'LOCAL EDIT — must survive' });
  const archive = await readLibraryArchive(await archiveBytes());

  const kept = await applyImport(archive, choices('Keep both'));
  expect(kept.runs).toEqual({ added: 0, replaced: 0, skipped: 1 });
  expect(kept.conversations).toEqual({ added: 0, replaced: 0, skipped: 1 });
  expect((await db.runs.get('run-1'))?.prompt).toBe('LOCAL EDIT — must survive');
  expect((await db.conversations.get('conversation-1'))?.title).toBe('LOCAL EDIT — must survive');

  const replaced = await applyImport(archive, choices('Replace existing'));
  expect(replaced.runs).toEqual({ added: 0, replaced: 1, skipped: 0 });
  expect(replaced.conversations).toEqual({ added: 0, replaced: 1, skipped: 0 });
  expect((await db.runs.get('run-1'))?.prompt).toBe(RUN.prompt);
  expect((await db.conversations.get('conversation-1'))?.title).toBe(CONVERSATION.title);
});

/* --------------------------------------------------------- dangling pointers */

it('a conversation pointing at an image with NO entry is imported, tolerated and named', async () => {
  const danglingConversation = conversationSchema.parse({
    ...CONVERSATION,
    id: 'conversation-dangling',
    messages: [{ ...USER_MESSAGE, id: 'message-dangling', imageIds: ['image-gone'] }],
  });
  const bytes = await archiveBytes({ ...SOURCE, conversations: [danglingConversation] });
  const archive = await readLibraryArchive(bytes);

  const preview = await previewImport(archive);
  expect(preview.danglingImageIds).toEqual(['image-gone']);

  const result = await applyImport(archive, choices());
  expect(result.danglingImageIds).toEqual(['image-gone']);
  const stored = await db.conversations.get('conversation-dangling');
  expect(stored?.messages[0]?.imageIds).toEqual(['image-gone']);
});

it('a reference that the LIVE library can still resolve is not reported as dangling', async () => {
  await seedLocalImage({ id: 'image-gone' });
  const danglingConversation = conversationSchema.parse({
    ...CONVERSATION,
    id: 'conversation-dangling',
    messages: [{ ...USER_MESSAGE, id: 'message-dangling', imageIds: ['image-gone'] }],
  });
  const archive = await readLibraryArchive(
    await archiveBytes({ ...SOURCE, conversations: [danglingConversation] }),
  );
  expect((await previewImport(archive)).danglingImageIds).toEqual([]);
});
