import { createHash } from 'node:crypto';

import { strFromU8, unzipSync } from 'fflate';
import { expect, it } from 'vitest';

import { conversationSchema, type Conversation } from '@/domain/chat';
import { runSchema, type Run, type StoredImage } from '@/domain/image';
import type { Settings } from '@/domain/settings';
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  KEY_OMITTED_NOTE,
  MANIFEST_ENTRY,
  buildBackupArchive,
  buildImagesArchive,
  buildManifest,
  exportFileName,
  exportManifestImageSchema,
  exportManifestSchema,
  formatBytes,
  imageFileName,
  imagesZipEntryName,
  internalImagePath,
  sanitizeFileName,
  type ExportManifest,
  type ExportSource,
} from '@/features/export/exportLibrary';

/**
 * docs/17 row 25 — the export format, pinned without a browser.
 *
 * The owner asked to get his work OUT of the browser: (A) all images as a ZIP,
 * (B) everything in an internal format that keeps his settings. What these pins
 * defend is exactly what would make that file useless or dangerous: bytes that
 * are not the stored bytes, the OpenRouter key riding along inside a file that
 * gets synced and backed up, and — for the import half the owner has now asked
 * for — a manifest that does not carry enough to REBUILD a library.
 *
 * The round-trip test at the bottom is the acceptance criterion for "the format
 * is not one-way": it reconstructs every row from the archive alone. Import is
 * deliberately NOT built here (a separate slice), but its reader can be written
 * from this format without guessing.
 */

/** The sentinel that must never reach any produced archive byte. */
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
  // A pointer INTO the image set — the field an import must not lose.
  inputImageIds: ['image-png'],
  requestedCount: 2,
  receivedCount: 2,
  filteredCount: 0,
  costUsd: 0.0123,
  createdAt: 1_700_000_000_000,
  error: null,
});

const CONVERSATION: Conversation = conversationSchema.parse({
  id: 'conversation-1',
  title: 'a red fox',
  model: 'openai/gpt-5-image',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  messages: [
    {
      id: 'message-1',
      role: 'user',
      text: 'make the sky darker',
      imageIds: ['image-jpeg'],
      runId: '',
      model: '',
      costUsd: null,
      error: null,
      createdAt: 1_700_000_000_000,
    },
    {
      id: 'message-2',
      role: 'assistant',
      text: 'done',
      imageIds: ['image-hostile'],
      runId: 'run-1',
      model: 'openai/gpt-5-image',
      costUsd: 0.02,
      error: null,
      createdAt: 1_700_000_000_500,
    },
  ],
});

/** A hostile prompt on purpose: slashes, a newline, emoji and 200+ characters. */
const HOSTILE_PROMPT = `../..\\etc/pa\nsswd 🌃 ${'very long '.repeat(20)}END`;

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

const IMAGES: StoredImage[] = [
  image({ id: 'image-png', bytes: new Uint8Array([9, 8, 7]), mimeType: 'image/png' }),
  // A FAVOURITE, so the round trip below pins `true` as well as the default.
  image({
    id: 'image-jpeg',
    bytes: new Uint8Array([6, 5, 4]),
    mimeType: 'image/jpeg',
    favorite: true,
  }),
  image({
    id: 'image-hostile',
    bytes: new Uint8Array([3, 2, 1]),
    mimeType: 'image/webp',
    prompt: HOSTILE_PROMPT,
  }),
];

const SOURCE: ExportSource = {
  images: IMAGES,
  runs: [RUN],
  conversations: [CONVERSATION],
  settings: SETTINGS,
};

const NOW = new Date('2026-09-26T08:10:11.123Z');

/** Every entry of an archive, as `unzipSync` yields it. */
function entriesOf(bytes: Uint8Array<ArrayBuffer>): Record<string, Uint8Array<ArrayBuffer>> {
  return unzipSync(bytes);
}

function latin1(bytes: Uint8Array): string {
  return strFromU8(bytes, true);
}

/** The manifest of a built archive, parsed back through the schema. */
async function manifestOf(source: ExportSource, now = NOW): Promise<ExportManifest> {
  const archive = await buildBackupArchive(source, now);
  const entries = entriesOf(archive.bytes);
  const raw = entries[MANIFEST_ENTRY];
  if (raw === undefined) throw new Error('archive has no manifest');
  return exportManifestSchema.parse(JSON.parse(strFromU8(raw)));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ------------------------------------------------------------ sanitization */

it('a hostile prompt never reaches a file name as a path, a dot-file or a newline', () => {
  const stem = sanitizeFileName(HOSTILE_PROMPT, 'image');
  expect(stem).not.toContain('/');
  expect(stem).not.toContain('\\');
  expect(stem).not.toContain('..');
  expect(stem).not.toContain('\n');
  expect(stem.startsWith('.')).toBe(false);
  expect(stem).not.toMatch(/[^A-Za-z0-9-]/);
  expect(stem.length).toBeLessThanOrEqual(60);
  // Nothing was silently blanked: the readable head of the prompt survives.
  expect(stem.startsWith('etc-pa-sswd')).toBe(true);
});

it('an unusable prompt falls back to the caller-supplied stem, then to `file`', () => {
  expect(sanitizeFileName('🌃🌃🌃', 'image')).toBe('image');
  expect(sanitizeFileName('', 'image-id')).toBe('image-id');
  expect(sanitizeFileName('///', '//')).toBe('file');
});

it('an image file name keeps the right extension and is collision-free per id', () => {
  const [png, jpeg, hostile] = IMAGES;
  if (png === undefined || jpeg === undefined || hostile === undefined) throw new Error('seed');
  expect(imageFileName(png)).toMatch(/\.png$/);
  expect(imageFileName(jpeg)).toMatch(/\.jpg$/);
  expect(imageFileName(hostile)).toMatch(/\.webp$/);
  expect(imageFileName(hostile)).not.toContain('/');
  // Two images of the SAME prompt cannot collide: the id stub differs.
  const first = imageFileName(image({ id: 'aaaa1111-0000', prompt: 'same' }));
  const second = imageFileName(image({ id: 'bbbb2222-0000', prompt: 'same' }));
  expect(first).not.toBe(second);
  // The entry name adds the ordering index on top, so a ZIP key is unique
  // whatever the prompts and ids are.
  expect(imagesZipEntryName(png, 0)).toBe(`001-${imageFileName(png)}`);
  expect(imagesZipEntryName(image({ id: 'aaaa1111-0000', prompt: 'same' }), 1)).not.toBe(
    imagesZipEntryName(image({ id: 'bbbb2222-0000', prompt: 'same' }), 0),
  );
});

it('a hostile or non-uuid id cannot escape the archive directory either', () => {
  const path = internalImagePath(image({ id: '../../evil/x', mimeType: 'image/png' }));
  expect(path.startsWith('images/')).toBe(true);
  expect(path.slice('images/'.length)).not.toContain('/');
  expect(path).not.toContain('..');
});

it('the reserved Windows device name `CON` cannot end up alone as a file name', () => {
  // The stem is always followed by the id stub, so a bare device name is
  // impossible — this is the pin for that. (A file actually named CON.png is
  // refused by Windows.)
  const name = imageFileName(image({ id: 'ffff0000-1111', prompt: 'CON' }));
  expect(name).not.toBe('CON.png');
  expect(name.startsWith('CON-')).toBe(true);
});

/* ------------------------------------------------------------- file naming */

it('the archive names are timestamped and colon-free (Windows-safe)', () => {
  expect(exportFileName('images', NOW)).toBe('imager-images-2026-09-26T08-10-11-123Z.zip');
  expect(exportFileName('backup', NOW)).toBe('imager-backup-2026-09-26T08-10-11-123Z.zip');
});

it('formatBytes reads the way a download manager would report it', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(999)).toBe('999 B');
  expect(formatBytes(1000)).toBe('1.0 kB');
  expect(formatBytes(3_440_000)).toBe('3.4 MB');
  expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
});

/* ------------------------------------------------- mode A — the images ZIP */

it('mode A contains exactly the gallery images, one entry each, with the stored bytes', () => {
  const archive = buildImagesArchive(IMAGES, NOW);
  expect(archive.mimeType).toBe('application/zip');
  const entries = entriesOf(archive.bytes);
  expect(Object.keys(entries)).toHaveLength(IMAGES.length);
  expect(Object.keys(entries)).not.toContain(MANIFEST_ENTRY);
  for (const image of IMAGES) {
    const key = Object.keys(entries).find((k) => k.endsWith(imageFileName(image)));
    expect(key, `entry for ${image.id}`).toBeDefined();
    if (key === undefined) continue;
    expect(Array.from(entries[key] ?? [])).toEqual(Array.from(image.bytes));
  }
  // The extension follows the MIME type, per entry.
  const keys = Object.keys(entries).sort();
  expect(keys.some((k) => k.endsWith('.png'))).toBe(true);
  expect(keys.some((k) => k.endsWith('.jpg'))).toBe(true);
  expect(keys.some((k) => k.endsWith('.webp'))).toBe(true);
});

it('mode A of an empty library is a valid empty archive, never a fabricated entry', () => {
  const entries = entriesOf(buildImagesArchive([], new Date()).bytes);
  expect(Object.keys(entries)).toEqual([]);
});

/* ------------------------------------------ mode B — the internal format */

it('mode B is manifest.json plus one raw-bytes entry per image', async () => {
  const archive = await buildBackupArchive(SOURCE, NOW);
  const entries = entriesOf(archive.bytes);
  expect(Object.keys(entries).sort()).toEqual(
    [MANIFEST_ENTRY, ...IMAGES.map(internalImagePath)].sort(),
  );
  for (const image of IMAGES) {
    expect(Array.from(entries[internalImagePath(image)] ?? [])).toEqual(Array.from(image.bytes));
  }
});

it('every image carries its byte length and a SHA-256 a reader can verify', async () => {
  const manifest = await manifestOf(SOURCE);
  for (const meta of manifest.images) {
    expect(meta.byteLength).toBeGreaterThan(0);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  // The hash is the REAL one (checked against Node's independent digest), and
  // it matches the bytes actually stored in the archive.
  const entries = entriesOf((await buildBackupArchive(SOURCE, NOW)).bytes);
  for (const [index, meta] of manifest.images.entries()) {
    const stored = entries[meta.fileName];
    if (stored === undefined) throw new Error(`missing entry ${meta.fileName}`);
    expect(stored.length).toBe(meta.byteLength);
    expect(sha256Hex(stored)).toBe(meta.sha256);
    expect(meta.sha256).toBe(sha256Hex(IMAGES[index]?.bytes ?? new Uint8Array()));
  }
});

it('the manifest states the format, the version and the deliberate key omission', async () => {
  const manifest = await manifestOf(SOURCE);
  expect(manifest.format).toBe(EXPORT_FORMAT);
  expect(manifest.version).toBe(EXPORT_FORMAT_VERSION);
  expect(manifest.version).toBe(1);
  expect(manifest.exportedAt).toBe(NOW.toISOString());
  expect(manifest.layout.manifest).toBe(MANIFEST_ENTRY);
  expect(manifest.layout.images).toContain('images/');
  expect(manifest.secretExcluded.fields).toEqual(['settings.openRouterApiKey']);
  expect(manifest.secretExcluded.note).toBe(KEY_OMITTED_NOTE);
  expect(manifest.description).toContain('backup');
});

/* --------------------------------------------------------- the key, absent */

it('the sentinel key appears NOWHERE in the produced archive bytes', async () => {
  const archive = await buildBackupArchive(SOURCE, NOW);
  const entries = entriesOf(archive.bytes);
  // 1. The manifest's own text (the sensitive check: a compressed entry would
  //    hide a plaintext sentinel from a raw scan, so the DECODED manifest is
  //    what must be clean).
  const manifestText = strFromU8(entries[MANIFEST_ENTRY] ?? new Uint8Array());
  expect(manifestText).not.toContain(KEY_SENTINEL);
  // The field NAME may appear exactly once — in `secretExcluded.fields`, where
  // it says the value was left out on purpose. Anywhere else is a leak.
  expect(manifestText.split('openRouterApiKey').length - 1).toBe(1);
  expect(JSON.parse(manifestText)).toMatchObject({
    secretExcluded: { fields: ['settings.openRouterApiKey'] },
  });
  // 2. Every entry, decoded, and the raw archive: "not anywhere in the bytes".
  for (const [name, data] of Object.entries(entries)) {
    expect(latin1(data), `entry ${name}`).not.toContain(KEY_SENTINEL);
  }
  expect(latin1(archive.bytes)).not.toContain(KEY_SENTINEL);
});

it('a settings field the export does not know about cannot ride along either', async () => {
  // The manifest's settings are an ALLOW-LIST, so a future secret field is
  // dropped by construction rather than by remembering to remove it.
  const widened = { ...SETTINGS, futureSecret: 'sk-or-v1-FUTURE' } as unknown as Settings;
  const manifest = await buildManifest({ ...SOURCE, settings: widened }, NOW.toISOString());
  expect(Object.keys(manifest.settings).sort()).toEqual(['imageModel', 'refineChatModel']);
  expect(JSON.stringify(manifest)).not.toContain('futureSecret');
  // And the strict schema refuses the key if anyone ever ADDS it back.
  const withKey = {
    ...manifest,
    settings: { ...manifest.settings, openRouterApiKey: KEY_SENTINEL },
  };
  expect(exportManifestSchema.safeParse(withKey).success).toBe(false);
});

/* ------------------------------------------------------- the round trip */

/**
 * THE acceptance criterion (dispatcher brief, and the owner's "load everything"
 * ask): from the archive ALONE, reconstruct every row. This runs today against
 * the exporter, so a field the reader would need cannot quietly go missing
 * while import is still unbuilt.
 */
it('ROUND TRIP: the archive alone rebuilds every row, and every pointer resolves', async () => {
  const archive = await buildBackupArchive(SOURCE, NOW);
  const entries = entriesOf(archive.bytes);
  const raw = entries[MANIFEST_ENTRY];
  if (raw === undefined) throw new Error('archive has no manifest');
  // The reader's whole input is the manifest plus the entries it names.
  const manifest = exportManifestSchema.parse(JSON.parse(strFromU8(raw)));

  // --- settings: reconstructable, and the key is simply not part of the model.
  expect(manifest.settings).toEqual({
    imageModel: SETTINGS.imageModel,
    refineChatModel: SETTINGS.refineChatModel,
  });

  // --- images: field-for-field the stored row, plus the bytes.
  const idsInArchive = manifest.images.map((i) => i.id);
  expect(new Set(idsInArchive).size).toBe(idsInArchive.length); // ids unique
  expect(manifest.images).toHaveLength(IMAGES.length);
  for (const source of IMAGES) {
    const meta = manifest.images.find((i) => i.id === source.id);
    expect(meta, `image ${source.id}`).toBeDefined();
    if (meta === undefined) continue;
    const { fileName, byteLength, sha256, ...row } = meta;
    // `row` IS the `StoredImage` row, minus the bytes — nothing missing, and the
    // favourite flag travels with it (docs/17 row 32).
    expect(row).toEqual({
      id: source.id,
      mimeType: source.mimeType,
      width: source.width,
      height: source.height,
      prompt: source.prompt,
      model: source.model,
      source: source.source,
      createdAt: source.createdAt,
      runId: source.runId,
      favorite: source.favorite,
    });
    expect(entries[fileName] !== undefined).toBe(true);
    expect(byteLength).toBe(source.bytes.length);
    expect(sha256).toBe(sha256Hex(source.bytes));
  }

  // --- runs: verbatim, including the pointer into the image set.
  expect(manifest.runs).toEqual([RUN]);
  const runIds = manifest.runs.map((r) => r.id);
  expect(new Set(runIds).size).toBe(runIds.length);
  for (const run of manifest.runs) {
    expect(run.inputImageIds.length).toBeGreaterThan(0);
    for (const id of run.inputImageIds) {
      expect(idsInArchive, `run ${run.id} inputImageIds`).toContain(id);
    }
  }

  // --- conversations: verbatim, including EVERY message pointer.
  expect(manifest.conversations).toEqual([CONVERSATION]);
  const conversationIds = manifest.conversations.map((c) => c.id);
  expect(new Set(conversationIds).size).toBe(conversationIds.length);
  for (const conversation of manifest.conversations) {
    expect(conversation.messages.length).toBeGreaterThan(0);
    for (const message of conversation.messages) {
      for (const id of message.imageIds) {
        expect(idsInArchive, `message ${message.id} imageIds`).toContain(id);
      }
      if (message.runId !== '') {
        expect(runIds, `message ${message.id} runId`).toContain(message.runId);
      }
    }
  }
});

it('the per-image manifest entry schema refuses a row missing its integrity fields', () => {
  const complete = {
    id: 'image-1',
    fileName: 'images/image-1.png',
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: 'x',
    model: 'm',
    source: 'generated',
    createdAt: 1,
    runId: '',
    byteLength: 3,
    sha256: sha256Hex(new Uint8Array([1, 2, 3])),
  };
  expect(exportManifestImageSchema.safeParse(complete).success).toBe(true);
  // `favorite` is ADDITIVE: an entry written before favourites existed (the
  // object above has no such key) reads as NOT a favourite rather than failing
  // (docs/17 row 32), and the flag survives when it IS there.
  expect(exportManifestImageSchema.parse(complete).favorite).toBe(false);
  expect(exportManifestImageSchema.parse({ ...complete, favorite: true }).favorite).toBe(true);
  for (const field of ['fileName', 'byteLength', 'sha256', 'runId', 'createdAt', 'source']) {
    const { [field as keyof typeof complete]: _dropped, ...rest } = complete;
    expect(exportManifestImageSchema.safeParse(rest).success, `missing ${field}`).toBe(false);
  }
});
