/**
 * THE import seam (docs/17 row 27): the ONE way a file gets back INTO the
 * library — the reader half of the internal format the export seam writes
 * (docs/17 row 25).
 *
 * WHAT IT IS NOT: it does not read the images-only ZIP. That archive carries no
 * manifest, so there is no settings, no run log, no chat history and no way to
 * know an entry's id — loading it would be guessing, and guessing is exactly
 * what rule 1 forbids. The reader refuses it by name (the missing
 * `manifest.json`) rather than importing a partial library.
 *
 * NEVER A PARTIAL OR BEST-EFFORT IMPORT: the WHOLE archive is validated before
 * anything is written — the manifest through the EXPORTER'S OWN
 * `exportManifestSchema` (one schema for both directions, so the format cannot
 * rot into a writer and a divergent reader), then every image's entry presence,
 * `byteLength` and `sha256`. Any mismatch THROWS with a message that names what
 * failed. `applyImport` is the only function that writes, and it is reached
 * only with a `ValidatedArchive` this module produced.
 *
 * THE KEY SURVIVES, BY CONSTRUCTION: the archive never contains
 * `openRouterApiKey` (the exporter omits it; the strict schema refuses a
 * hand-edited manifest that re-adds it). When the owner chooses "Apply
 * settings", the settings are written through `updateSettings` — the app's ONE
 * settings seam, which MERGES the given fields over the CURRENT row. The key is
 * therefore read from the live database and written back untouched, in every
 * branch; this module never mentions the field. (Pin:
 * tests/features/import-panel.test.tsx and tests/import/importLibrary.test.ts.)
 *
 * Dangling references are TOLERATED, DELIBERATELY: `deleteImage` does not scrub
 * conversations, so a real library can hold a conversation (or a run's
 * `inputImageIds`) pointing at an image that is gone. A backup of such a library
 * is valid, and refusing it would lose everything else; the reader imports it
 * and REPORTS the ids that will not resolve, so the owner is told rather than
 * quietly handed a broken pointer.
 */
import type { EntityTable } from 'dexie';

import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { type Conversation } from '@/domain/chat';
import { runSchema, storedImageSchema, type StoredImage } from '@/domain/image';
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  MANIFEST_ENTRY,
  exportManifestSchema,
  type ExportManifest,
  type ExportManifestImage,
} from '@/features/export/exportLibrary';
import { errorMessage } from '@/lib/errors';
import { sha256Hex } from '@/lib/sha256';
import { strFromU8, unzipSync } from '@/lib/zip';

/* ------------------------------------------------------------- the choices */

/**
 * The owner's re-import conflict decision (docs/17 row 25, owner-verbatim: "Ask
 * me at import time"). The LABEL is the value because the shared `Segmented`
 * control renders its options directly — one vocabulary, no id/label mapping.
 */
export const CONFLICT_CHOICES = ['Keep both', 'Replace existing'] as const;
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];

/**
 * The owner's settings decision (owner-verbatim: "Let me choose per import").
 * Either way the OpenRouter key is not in the file and not touched.
 */
export const SETTINGS_CHOICES = ['Apply settings', 'Keep my settings'] as const;
export type SettingsChoice = (typeof SETTINGS_CHOICES)[number];

export interface ImportChoices {
  conflict: ConflictChoice;
  settings: SettingsChoice;
}

/* ------------------------------------------------------------- the reader */

/** One manifest image entry plus the bytes its entry actually held. */
export interface ArchiveImage {
  meta: ExportManifestImage;
  bytes: Uint8Array<ArrayBuffer>;
}

/** A fully validated archive: safe to preview and, after the owner chooses, to
 * write. Nothing else may be passed to `applyImport`. */
export interface ValidatedArchive {
  manifest: ExportManifest;
  images: ArchiveImage[];
}

/** `JSON.parse` yields `any`; this keeps the strict lint honest at the boundary. */
function asJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The manifest, validated with the EXPORTER'S schema. The format and version
 * are checked FIRST so the owner gets "this is a different kind of file" rather
 * than a raw zod issue list — and `strictObject` then refuses anything the
 * format does not define, including a hand-edited `openRouterApiKey`.
 */
function parseManifest(value: unknown): ExportManifest {
  const parsed = exportManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const raw = asJsonObject(value);
  if (raw !== null) {
    if (raw.format !== EXPORT_FORMAT) {
      throw new Error(
        `This file is not an Imager library backup: its manifest format is ${JSON.stringify(raw.format)}, expected "${EXPORT_FORMAT}".`,
      );
    }
    if (raw.version !== EXPORT_FORMAT_VERSION) {
      throw new Error(
        `This backup uses internal format version ${JSON.stringify(raw.version)}, but this build reads version ${EXPORT_FORMAT_VERSION} only.`,
      );
    }
  }
  throw new Error(
    `The archive's ${MANIFEST_ENTRY} is not a valid Imager manifest: ${parsed.error.message}`,
  );
}

/**
 * Read an archive's bytes into a validated picture of the library it holds.
 * THROWS (naming the problem) on anything that would make the import partial:
 * an unreadable ZIP, a missing manifest, invalid JSON, a manifest the schema
 * refuses, a duplicate image id, a missing image entry, or an integrity
 * mismatch. It writes NOTHING.
 */
export async function readLibraryArchive(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ValidatedArchive> {
  let entries: Record<string, Uint8Array<ArrayBuffer>>;
  try {
    entries = unzipSync(bytes);
  } catch (error: unknown) {
    throw new Error(`This file is not a readable ZIP archive: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const rawManifest = entries[MANIFEST_ENTRY];
  if (rawManifest === undefined) {
    throw new Error(
      `This ZIP has no ${MANIFEST_ENTRY} at its root, so it is not an Imager library backup. ` +
        'The images-only ZIP carries no manifest and cannot be loaded — use the backup ZIP.',
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(strFromU8(rawManifest));
  } catch (error: unknown) {
    throw new Error(`${MANIFEST_ENTRY} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  const manifest = parseManifest(parsedJson);

  const images: ArchiveImage[] = [];
  const seenIds = new Set<string>();
  for (const meta of manifest.images) {
    if (seenIds.has(meta.id)) {
      throw new Error(
        `The manifest lists the image id "${meta.id}" more than once — refusing an archive that cannot say which bytes belong to it.`,
      );
    }
    seenIds.add(meta.id);

    const entry = entries[meta.fileName];
    if (entry === undefined) {
      throw new Error(
        `The backup is incomplete: image "${meta.id}" names the entry "${meta.fileName}", but no such entry is in the archive.`,
      );
    }
    if (entry.length !== meta.byteLength) {
      throw new Error(
        `Image "${meta.id}" ("${meta.fileName}") is ${entry.length} bytes in the archive but the manifest says ${meta.byteLength} — refusing a partial import.`,
      );
    }
    const digest = await sha256Hex(entry);
    if (digest !== meta.sha256) {
      throw new Error(
        `Image "${meta.id}" ("${meta.fileName}") failed its integrity check: the archive's SHA-256 is ${digest}, the manifest's is ${meta.sha256}. The file is corrupt or was modified — nothing was imported.`,
      );
    }
    images.push({ meta, bytes: entry });
  }

  return { manifest, images };
}

/* ------------------------------------------------------------- the preview */

/** How many of one table's incoming rows are new and how many already exist. */
export interface TablePlan {
  /** How many rows the archive carries for this table. */
  incoming: number;
  /** Ids not in the live database: added under EITHER conflict choice. */
  fresh: number;
  /** Ids already in the live database: skipped or overwritten, per the choice. */
  existing: number;
}

/** What an import would do, computed against the live database, before writing. */
export interface ImportPreview {
  /** The archive's own `exportedAt` (ISO-8601), for "made on …". */
  exportedAt: string;
  /** The archive's non-secret settings, shown so the choice is informed. */
  settings: ExportManifest['settings'];
  images: TablePlan;
  runs: TablePlan;
  conversations: TablePlan;
  /**
   * Image ids referenced by the archive's runs/conversations that resolve to
   * NEITHER an archive entry NOR the live library — they will still be dangling
   * after the import. Imported anyway, and named so the owner knows.
   */
  danglingImageIds: string[];
}

function planFor(incomingIds: readonly string[], existing: ReadonlySet<string>): TablePlan {
  const fresh = incomingIds.filter((id) => !existing.has(id)).length;
  return { incoming: incomingIds.length, fresh, existing: incomingIds.length - fresh };
}

/** Every image id the archive's runs and conversations point at. */
function referencedImageIds(manifest: ExportManifest): Set<string> {
  const referenced = new Set<string>();
  for (const run of manifest.runs) for (const id of run.inputImageIds) referenced.add(id);
  for (const conversation of manifest.conversations) {
    for (const message of conversation.messages) {
      for (const id of message.imageIds) referenced.add(id);
    }
  }
  return referenced;
}

function danglingIds(manifest: ExportManifest, resolvable: ReadonlySet<string>): string[] {
  return [...referencedImageIds(manifest)].filter((id) => !resolvable.has(id)).sort();
}

/** The ids the live database already holds for one table. */
async function existingIds<T extends { id: string }>(
  table: EntityTable<T, 'id'>,
): Promise<Set<string>> {
  const keys = await table.toCollection().primaryKeys();
  return new Set(keys);
}

/**
 * What importing `archive` would do, read from the live database. This is what
 * the UI shows BEFORE the owner commits to anything (owner decision: the
 * conflict choice needs a count of new vs existing), so the two options are
 * informed rather than blind.
 */
export async function previewImport(archive: ValidatedArchive): Promise<ImportPreview> {
  const [imageIds, runIds, conversationIds] = await Promise.all([
    existingIds(db.images),
    existingIds(db.runs),
    existingIds(db.conversations),
  ]);
  const { manifest } = archive;
  // An image resolves after the import if the archive carries it (it will be
  // written) or the library already has it (either conflict choice leaves it
  // present).
  const resolvable = new Set<string>([...imageIds, ...manifest.images.map((image) => image.id)]);
  return {
    exportedAt: manifest.exportedAt,
    settings: manifest.settings,
    images: planFor(
      manifest.images.map((image) => image.id),
      imageIds,
    ),
    runs: planFor(
      manifest.runs.map((run) => run.id),
      runIds,
    ),
    conversations: planFor(
      manifest.conversations.map((conversation) => conversation.id),
      conversationIds,
    ),
    danglingImageIds: danglingIds(manifest, resolvable),
  };
}

/* --------------------------------------------------------------- the apply */

/** What was actually written for one table. */
export interface WriteTally {
  added: number;
  replaced: number;
  skipped: number;
}

/** The honest report of an import: per-table totals, plus what settings did. */
export interface ImportResult {
  images: WriteTally;
  runs: WriteTally;
  conversations: WriteTally;
  /** True only for the "Apply settings" choice, and only if the write returned. */
  settingsApplied: boolean;
  danglingImageIds: string[];
}

/** The whole result as one short sentence (the toast and the panel show the
 * SAME string, so the confirmation on screen cannot disagree with the notice). */
export function importResultSummary(result: ImportResult): string {
  const part = (name: string, tally: WriteTally): string =>
    `${name}: ${tally.added.toString()} added, ${tally.replaced.toString()} replaced, ${tally.skipped.toString()} skipped`;
  return [
    part('images', result.images),
    part('runs', result.runs),
    part('conversations', result.conversations),
    result.settingsApplied ? 'settings applied' : 'settings kept',
  ].join(' · ');
}

/**
 * Write one table under the owner's conflict choice. Existing rows are left
 * alone ("Keep both") or overwritten ("Replace existing"); either way the
 * tally says which happened, because "it imported" is not a report.
 */
async function writeRows<T extends { id: string }>(
  table: EntityTable<T, 'id'>,
  rows: readonly T[],
  conflict: ConflictChoice,
): Promise<WriteTally> {
  const existing = await existingIds(table);
  const fresh = rows.filter((row) => !existing.has(row.id));
  const matching = rows.filter((row) => existing.has(row.id));
  if (conflict === 'Keep both') {
    if (fresh.length > 0) await table.bulkPut(fresh);
    return { added: fresh.length, replaced: 0, skipped: matching.length };
  }
  if (rows.length > 0) await table.bulkPut(rows);
  return { added: fresh.length, replaced: matching.length, skipped: 0 };
}

/** A manifest image entry plus its verified bytes → the stored row. */
function imageRow(meta: ExportManifestImage, bytes: Uint8Array<ArrayBuffer>): StoredImage {
  return storedImageSchema.parse({
    id: meta.id,
    bytes,
    mimeType: meta.mimeType,
    width: meta.width,
    height: meta.height,
    prompt: meta.prompt,
    model: meta.model,
    source: meta.source,
    createdAt: meta.createdAt,
    runId: meta.runId,
    // Already defaulted to `false` by the manifest schema when the archive was
    // written before favourites existed (docs/17 row 32).
    favorite: meta.favorite,
  });
}

/**
 * Apply a validated archive. ONE Dexie transaction across every table it writes
 * (images, runs, conversations and — when settings are applied — settings), so
 * a failure anywhere leaves the library exactly as it was: a half-imported
 * library would be worse than no import.
 *
 * The settings branch is the dangerous one: `updateSettings` MERGES the two
 * non-secret fields over the CURRENT row, so `openRouterApiKey` is read from the
 * live database and written back unchanged. This function never names the key.
 */
export async function applyImport(
  archive: ValidatedArchive,
  choices: ImportChoices,
): Promise<ImportResult> {
  const images = archive.images.map(({ meta, bytes }) => imageRow(meta, bytes));
  const runs = archive.manifest.runs.map((run) => runSchema.parse(run));
  const conversations: Conversation[] = archive.manifest.conversations;
  const resolvable = new Set<string>([
    ...(await existingIds(db.images)),
    ...archive.manifest.images.map((image) => image.id),
  ]);
  const dangling = danglingIds(archive.manifest, resolvable);

  return db.transaction(
    'rw',
    db.images,
    db.runs,
    db.conversations,
    db.settings,
    async (): Promise<ImportResult> => {
      const imageTally = await writeRows(db.images, images, choices.conflict);
      const runTally = await writeRows(db.runs, runs, choices.conflict);
      const conversationTally = await writeRows(db.conversations, conversations, choices.conflict);

      let settingsApplied = false;
      if (choices.settings === 'Apply settings') {
        // MERGE, never replace: the current row (and therefore the live
        // OpenRouter key) carries through untouched.
        await updateSettings({
          imageModel: archive.manifest.settings.imageModel,
          refineChatModel: archive.manifest.settings.refineChatModel,
        });
        settingsApplied = true;
      }

      return {
        images: imageTally,
        runs: runTally,
        conversations: conversationTally,
        settingsApplied,
        danglingImageIds: dangling,
      };
    },
  );
}
