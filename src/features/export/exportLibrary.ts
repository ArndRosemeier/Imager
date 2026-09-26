/**
 * THE export seam (docs/17 row 25): the ONE place the owner's library leaves
 * the browser as a file.
 *
 * TWO SHAPES, ONE IMPLEMENTATION (rule 4): `mode 'images'` is the pictures as a
 * plain ZIP any tool can open; `mode 'backup'` is the internal format — a
 * manifest plus the raw image bytes — that a future IMPORT can reconstruct the
 * library from. Both are built by this module with `fflate` (the one zip
 * dependency); a second zip writer, or a second manifest builder, is a defect
 * (pin: tests/architecture/one-export.test.ts).
 *
 * WHY A ZIP FOR THE INTERNAL FORMAT AND NOT ONE JSON BLOB: base64-ing every
 * image into JSON inflates the library by ~33%, and the result cannot be opened
 * or partially recovered by anything else. Raw bytes under `images/` plus a
 * `manifest.json` at the root stay self-describing AND recoverable.
 *
 * THE KEY IS NEVER IN AN EXPORT (owner-facing decision, docs/17 row 25): an
 * export file is a file — it gets emailed, synced, backed up to a cloud drive.
 * The manifest carries the settings WITHOUT `openRouterApiKey` and says so in
 * `secretExcluded`; `KEY_OMITTED_NOTE` is the ONE string both the manifest and
 * the UI use, so what the owner reads before saving cannot drift from what the
 * file says. (A "backup including my key" variant is the OWNER's call and is
 * deliberately NOT built — it is noted as an offered follow-up in the ledger.)
 *
 * The builders are pure: rows in, bytes out. Only `collectExportSource`,
 * `libraryStats` and `buildLibraryArchive` touch Dexie, so the format itself is
 * pinned without a browser.
 */
import { z } from 'zod';

import { listConversations } from '@/db/chatRepo';
import { listImages, listRuns } from '@/db/imageRepo';
import { getSettings } from '@/db/settingsRepo';
import { conversationSchema, type Conversation } from '@/domain/chat';
import {
  IMAGE_SOURCES,
  extensionFor,
  runSchema,
  type Run,
  type StoredImage,
} from '@/domain/image';
import type { Settings } from '@/domain/settings';
import { sha256Hex } from '@/lib/sha256';
import { strToU8, zipSync, type Zippable } from '@/lib/zip';

/* --------------------------------------------------------------- constants */

/** The internal format's id. A future import refuses anything else. */
export const EXPORT_FORMAT = 'imager-library' as const;

/**
 * The internal format's version. BUMP IT when a manifest field changes meaning
 * or is removed — a future import keys its reader off this number. An ADDED
 * field with a default does NOT bump it: the reader accepts exactly this number,
 * so a bump would refuse every backup written before the field existed, which
 * is the opposite of what the added field is for (docs/17 row 32).
 */
export const EXPORT_FORMAT_VERSION = 1 as const;

/** The manifest's entry name at the archive root. */
export const MANIFEST_ENTRY = 'manifest.json';

/** The directory the raw image bytes live under in the internal format. */
export const INTERNAL_IMAGE_DIR = 'images';

/** The ONE archive MIME type (both modes are ZIPs). */
export const ARCHIVE_MIME_TYPE = 'application/zip';

/**
 * The key-exclusion sentence. It is written into the manifest AND shown in the
 * UI BEFORE the owner saves, from this one constant — the file and the screen
 * cannot disagree about what is missing.
 */
export const KEY_OMITTED_NOTE =
  'The OpenRouter API key is deliberately NOT included in any Imager export: ' +
  'an export is a file, and a key in a file gets emailed, synced and backed ' +
  'up. Re-enter it in Settings after an import.';

/** The longest prompt-derived stem a suggested file name will carry. */
export const FILE_NAME_STEM_MAX_CHARS = 60;

/** How much of an image id is kept in a human-facing file name. */
export const FILE_NAME_ID_STUB_CHARS = 8;

/** The two export shapes. */
export const EXPORT_MODES = ['images', 'backup'] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

/* ------------------------------------------------------------- file naming */

/**
 * Anything that is not an ASCII letter or digit becomes a single `-`. This is
 * an OUTPUT ENCODER, not a parser: it never reads meaning out of the text
 * (AGENTS rule 5 forbids parsing free text), it maps arbitrary text onto the
 * character contract a file name has. The allow-list is deliberately tiny so
 * that `/`, `\`, `..`, control characters, newlines, emoji and unicode all
 * disappear, and a stem can neither be a hidden dot-file nor a parent-directory
 * reference.
 */
const UNSAFE_FILE_NAME_RUN = /[^A-Za-z0-9]+/g;

/**
 * `text` as a safe file-name STEM: unsafe runs collapsed to `-`, ends trimmed,
 * capped at `FILE_NAME_STEM_MAX_CHARS`. An empty result falls back to
 * `fallback` (itself sanitized) and finally to `file`, so the result is never
 * empty and never contains a path separator.
 */
export function sanitizeFileName(text: string, fallback: string): string {
  const slug = text
    .replace(UNSAFE_FILE_NAME_RUN, '-')
    .replace(/^-+/, '')
    .slice(0, FILE_NAME_STEM_MAX_CHARS)
    .replace(/-+$/, '');
  if (slug !== '') return slug;
  const safeFallback = fallback.replace(UNSAFE_FILE_NAME_RUN, '-').replace(/^-+|-+$/g, '');
  return safeFallback === '' ? 'file' : safeFallback;
}

/**
 * The owner-facing name for ONE image: a readable slug of its prompt plus a
 * short id stub, so two pictures of the same prompt can never collide. The stub
 * itself goes through the sanitizer because `StoredImage.id` is only
 * `z.string().min(1)` — a hostile row must not reach a path either.
 */
export function imageFileName(image: StoredImage): string {
  const stem = sanitizeFileName(image.prompt, 'image');
  const stub = sanitizeFileName(image.id, 'id').slice(0, FILE_NAME_ID_STUB_CHARS);
  return `${stem}-${stub}.${extensionFor(image.mimeType)}`;
}

/**
 * The entry name for one image inside the IMAGES zip: the owner-facing name
 * with a zero-padded index in front. The index makes the KEY collision-free
 * whatever the prompts are (two entries with the same key would silently
 * overwrite each other inside the archive) and keeps the owner's gallery order.
 */
export function imagesZipEntryName(image: StoredImage, index: number): string {
  return `${String(index + 1).padStart(3, '0')}-${imageFileName(image)}`;
}

/**
 * The path of one image inside the INTERNAL format. Keyed by id, not by prompt:
 * the manifest's `images[].fileName` names this entry, and the id is the stable
 * key an import would match rows on. The id is sanitized all the same (see
 * above).
 */
export function internalImagePath(image: StoredImage): string {
  return `${INTERNAL_IMAGE_DIR}/${sanitizeFileName(image.id, 'image')}.${extensionFor(
    image.mimeType,
  )}`;
}

/** `2026-09-26T08:10:11.123Z` → `2026-09-26T08-10-11-123Z` (no `:` or `.` on
 * Windows, and one unambiguous `.zip` at the end). */
function isoFileStamp(now: Date): string {
  return now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

/** The suggested file name for one mode: timestamped and self-explanatory. */
export function exportFileName(mode: ExportMode, now: Date): string {
  const kind = mode === 'images' ? 'imager-images' : 'imager-backup';
  return `${kind}-${isoFileStamp(now)}.zip`;
}

/** One built archive, ready for the save seam: a name, a type and the bytes. */
export interface ExportArchive {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/* ------------------------------------------------------ the internal format */

/**
 * The settings a manifest carries: EVERYTHING except the key. A strict object
 * (like `settingsSchema`) so an unexpected field — a future secret, or a
 * reintroduced key — FAILS to validate instead of shipping silently.
 */
export const exportedSettingsSchema = z.strictObject({
  imageModel: z.string(),
  refineChatModel: z.string(),
});

/**
 * One image's metadata inside the manifest. `fileName` is the archive-relative
 * entry holding its RAW bytes — an import must never have to guess an extension
 * from `mimeType`. `byteLength` and `sha256` are the integrity pair: a reader
 * verifies what it read instead of trusting it, so a truncated or corrupted
 * entry is a LOUD failure rather than a silently wrong image (rule 1).
 */
export const exportManifestImageSchema = z.strictObject({
  id: z.string().min(1),
  /** The ZIP entry path holding this image's raw bytes. */
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  prompt: z.string(),
  model: z.string().min(1),
  source: z.enum(IMAGE_SOURCES),
  createdAt: z.number(),
  runId: z.string(),
  /**
   * The owner's favourite flag (docs/17 row 32). `.default(false)` is what makes
   * an archive exported BEFORE this field existed import as "not a favourite"
   * instead of failing: the manifest is a `strictObject`, so the default is the
   * one thing standing between an old backup and a zod refusal. Pinned in
   * tests/import/importLibrary.test.ts.
   */
  favorite: z.boolean().default(false),
  /** The stored byte length. */
  byteLength: z.number().int().nonnegative(),
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ExportManifestImage = z.infer<typeof exportManifestImageSchema>;

/**
 * THE internal format (version 1). Zod at the boundary in BOTH directions: the
 * builder validates what it writes, so a malformed manifest cannot be produced,
 * and an import has a schema to read with. `strictObject` is load-bearing — it
 * is what makes `openRouterApiKey` fail rather than ride along.
 */
export const exportManifestSchema = z.strictObject({
  /** Format id; an import refuses anything else. */
  format: z.literal(EXPORT_FORMAT),
  /** Format version; see `EXPORT_FORMAT_VERSION`. */
  version: z.literal(EXPORT_FORMAT_VERSION),
  app: z.literal('Imager'),
  /** ISO-8601 instant the archive was built. */
  exportedAt: z.string().min(1),
  /** What this file IS, in plain words. */
  description: z.string().min(1),
  /** How to read the archive, so the format is self-describing. */
  layout: z.strictObject({
    manifest: z.literal(MANIFEST_ENTRY),
    images: z.string().min(1),
    imageBytes: z.string().min(1),
  }),
  /** What is deliberately NOT in the file, and why. */
  secretExcluded: z.strictObject({
    fields: z.array(z.string().min(1)),
    note: z.string().min(1),
  }),
  /** The settings row WITHOUT `openRouterApiKey`. */
  settings: exportedSettingsSchema,
  /** One entry per stored image, each naming its own bytes. */
  images: z.array(exportManifestImageSchema),
  /** The run log, verbatim. */
  runs: z.array(runSchema),
  /** The chat conversations, verbatim (images by id, as stored). */
  conversations: z.array(conversationSchema),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

/** Everything a backup carries, exactly as the repos read it. */
export interface ExportSource {
  images: readonly StoredImage[];
  runs: readonly Run[];
  conversations: readonly Conversation[];
  settings: Settings;
}

/**
 * The manifest for a source. The settings are copied FIELD BY FIELD on purpose:
 * an allow-list means a field added to `Settings` later cannot leak into an
 * export by default — the one thing an export must never do is surprise the
 * owner with a credential inside it.
 *
 * ASYNC because of the per-image SHA-256. The exporter writes NO conflict
 * policy: the ids it carries are what an import UI counts overlaps with, and
 * what to do about an overlap is the owner's per-import choice (docs/17 row 25),
 * never a decision baked in here.
 */
export async function buildManifest(
  source: ExportSource,
  exportedAt: string,
): Promise<ExportManifest> {
  const images = await Promise.all(
    source.images.map(async (image) => ({
      id: image.id,
      fileName: internalImagePath(image),
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      prompt: image.prompt,
      model: image.model,
      source: image.source,
      createdAt: image.createdAt,
      runId: image.runId,
      favorite: image.favorite,
      byteLength: image.bytes.length,
      sha256: await sha256Hex(image.bytes),
    })),
  );
  return exportManifestSchema.parse({
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    app: 'Imager',
    exportedAt,
    description:
      'Imager library backup — an internal, self-describing format. ' +
      `${MANIFEST_ENTRY} (this file) names every row; image bytes are stored raw ` +
      `under ${INTERNAL_IMAGE_DIR}/. Every image carries its byte length and SHA-256, ` +
      'so a reader can verify what it read. No OpenRouter API key is included.',
    layout: {
      manifest: MANIFEST_ENTRY,
      images: `${INTERNAL_IMAGE_DIR}/<id>.<ext>`,
      imageBytes:
        'raw image bytes (never base64) — each images[].fileName above is the archive-relative path',
    },
    secretExcluded: {
      fields: ['settings.openRouterApiKey'],
      note: KEY_OMITTED_NOTE,
    },
    settings: {
      imageModel: source.settings.imageModel,
      refineChatModel: source.settings.refineChatModel,
    },
    images,
    runs: source.runs,
    conversations: source.conversations,
  });
}

/* ------------------------------------------------------------- the builders */

/**
 * Mode A — the pictures, one entry each, in a form any tool can open. The image
 * bytes are STORED (`level: 0`), not deflated: they are already-compressed PNG/
 * JPEG/WebP data, so deflating them costs time for no size gain, and storing
 * them keeps each entry's size honest to the owner.
 */
export function buildImagesArchive(
  images: readonly StoredImage[],
  now: Date,
): ExportArchive {
  const files: Zippable = {};
  images.forEach((image, index) => {
    files[imagesZipEntryName(image, index)] = [image.bytes, { level: 0 }];
  });
  return { fileName: exportFileName('images', now), mimeType: ARCHIVE_MIME_TYPE, bytes: zipSync(files) };
}

/**
 * Mode B — the internal format: `manifest.json` at the root (compressed; it is
 * text) plus one raw-bytes entry per image. The manifest is built and validated
 * BEFORE the archive, so a malformed manifest throws instead of producing a
 * file whose header lies about its contents.
 */
export async function buildBackupArchive(source: ExportSource, now: Date): Promise<ExportArchive> {
  const manifest = await buildManifest(source, now.toISOString());
  const files: Zippable = { [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)) };
  for (const image of source.images) {
    const path = internalImagePath(image);
    // Two rows resolving to one entry would let the second silently destroy the
    // first inside the archive; a backup must never lose data quietly (rule 1).
    if (files[path] !== undefined) {
      throw new Error(
        `Two stored images resolve to the same archive entry "${path}" — refusing to write a backup that would silently lose one of them.`,
      );
    }
    files[path] = [image.bytes, { level: 0 }];
  }
  return {
    fileName: exportFileName('backup', now),
    mimeType: ARCHIVE_MIME_TYPE,
    bytes: zipSync(files),
  };
}

/* ------------------------------------------------------- reading the library */

/** Every row the backup carries, in the repos' own (validated) order. */
export async function collectExportSource(): Promise<ExportSource> {
  const [images, runs, conversations, settings] = await Promise.all([
    listImages(),
    listRuns(),
    listConversations(),
    getSettings(),
  ]);
  return { images, runs, conversations, settings };
}

/** What the library holds, for the size the owner is shown before saving. */
export interface LibraryStats {
  imageCount: number;
  /** The stored image bytes in total — an honest lower bound for the archives. */
  imageBytes: number;
  runCount: number;
  conversationCount: number;
}

/**
 * The counts and the raw image-byte total. This reads the image rows (bytes
 * included); the app is local-first and the panel shows the result once, so a
 * dedicated index would be machinery serving nothing.
 */
export async function libraryStats(): Promise<LibraryStats> {
  const [images, runs, conversations] = await Promise.all([
    listImages(),
    listRuns(),
    listConversations(),
  ]);
  return {
    imageCount: images.length,
    imageBytes: images.reduce((total, image) => total + image.bytes.length, 0),
    runCount: runs.length,
    conversationCount: conversations.length,
  };
}

/**
 * Build the archive for one mode from the LIVE library. This is what the UI's
 * save buttons call — remember it runs AFTER the file picker returns (the
 * picker needs the click's transient activation, and reading + zipping a large
 * library can outlive that window): see `src/lib/saveFile.ts`.
 */
export async function buildLibraryArchive(
  mode: ExportMode,
  now: Date,
): Promise<Uint8Array<ArrayBuffer>> {
  if (mode === 'images') return buildImagesArchive(await listImages(), now).bytes;
  return (await buildBackupArchive(await collectExportSource(), now)).bytes;
}

/** A byte total as a short human string (`3.4 MB`, decimal units). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes / 1000;
  let unit = 'kB';
  if (value >= 1000) {
    value /= 1000;
    unit = 'MB';
  }
  if (value >= 1000) {
    value /= 1000;
    unit = 'GB';
  }
  if (value >= 1000) {
    value /= 1000;
    unit = 'TB';
  }
  return `${value.toFixed(1)} ${unit}`;
}
