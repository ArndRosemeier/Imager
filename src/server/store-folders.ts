/**
 * THE ServerStore FOLDER seam (docs/17 row 42): the ONE place the folder
 * record, the folder index and the images are read, listed, written and
 * rebuilt.
 *
 * ONE LISTING IS THE WHOLE DIRECTORY. `GET /stores/imager/objects` returns
 * every object with its `sha256`, so this module reads it once and partitions
 * it by name (`parseObjectName`):
 *
 *   folder-<slug>          → the folder RECORD (owner, displayName, private)
 *   folder-<slug>-index    → the derived INDEX (cheap folder listing)
 *   i-<slug>-<seq>         → one image OBJECT
 *
 * A folder with no record is NOT a folder (the slot is reserved so a
 * half-finished write cannot present itself as one). An index that is missing,
 * unparsable or STALE is REBUILT from the listing plus each image's own header
 * — never shown as an empty folder (the loud-rebuild rule).
 *
 * PRIVACY IS HONOUR-BASED, AND THIS IS WHERE THAT IS DECIDED. The API has no
 * per-object permissions, so a `private` folder is hidden by the APP when it
 * lists "public folders" for someone else's key and is fully readable by every
 * key scoped to this store. The UI says so in those words; nothing here claims
 * otherwise.
 *
 * SEQUENCING AND THE RACE. `seq` is read from the index's `nextSeq`, but the
 * API has no compare-and-swap and `PUT` is an unconditional overwrite, so two
 * writers can choose the same sequence. This module therefore checks the
 * LISTING for the target name immediately before writing and takes the next
 * free sequence on a collision — and the residual race (two writers inside the
 * same instant) is stated honestly in the ledger rather than papered over.
 */
import type { z } from 'zod';

import { sha256Hex } from '@/lib/sha256';
import {
  imageObjectName,
  indexObjectName,
  folderObjectName,
  parseObjectName,
  parseImageObject,
  buildImageObject,
  emptyFolderIndex,
  folderIndexSchema,
  folderRecordSchema,
  imageHeaderSchema,
  slugFromLabel,
  slugFallbackForKey,
  OBJECT_VERSION,
  type FolderIndex,
  type FolderRecord,
  type ImageHeader,
  type IndexImage,
} from '@/server/store-files';
import {
  getObject,
  listObjects,
  putObject,
  type ObjectEntry,
  type StoreTarget,
  type WhoAmI,
} from '@/server/store-client';

/** How many sequence-collision retries an upload may make before giving up. */
export const MAX_SEQ_ATTEMPTS = 5;

/**
 * Does this index describe EVERY image the listing reports, with the listing's
 * own hash for each? A stale index (one entry short, or an entry whose object
 * was overwritten in place) must not be trusted — see `readDirectory`.
 */
function indexCovers(
  index: FolderIndex,
  names: readonly string[],
  byName: ReadonlyMap<string, ObjectEntry>,
): boolean {
  if (index.images.length !== names.length) return false;
  const seen = new Map(index.images.map((image) => [image.name, image.sha256]));
  return names.every((name) => seen.get(name) === byName.get(name)?.sha256);
}

/** One folder as the app shows it: the record plus what a listing adds. */
export interface FolderListing {
  record: FolderRecord;
  /** The index, or `null` when it must be rebuilt. */
  index: FolderIndex | null;
  /** True when the index was absent or unparsable — the UI says so. */
  indexMissing: boolean;
  /** The image objects the listing reports for this folder. */
  imageNames: string[];
}

/** Everything one listing tells the app about the store. */
export interface Directory {
  entries: ObjectEntry[];
  folders: FolderListing[];
  /** Object names this app did not write; ignored, never an error. */
  foreignNames: string[];
  /** The listing by object name — the sizes and hashes the index must carry. */
  byName: Map<string, ObjectEntry>;
}

/** Parse one stored JSON record with zod, or `null` when it does not parse —
 * the caller decides whether that is "rebuild it" (index) or "not a folder"
 * (record); it is never silently treated as valid data. */
function parseJsonOrNull<T>(text: string, schema: z.ZodType<T>): T | null {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Read ONE object's text, or `null` on `404`.
 *
 * A `404` is a MEANINGFUL answer here (the object is not there), not a
 * failure; every other error propagates with its real reason (rule 1).
 */
async function readTextOrNull(target: StoreTarget, name: string): Promise<string | null> {
  try {
    const { bytes } = await getObject(target, name);
    return new TextDecoder().decode(bytes);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'not_found') {
      return null;
    }
    throw error;
  }
}

/**
 * ONE listing → the whole directory. The index OBJECT is parsed here when it is
 * present; a missing or unparsable one is reported as `indexMissing` so the
 * caller can rebuild it instead of believing an empty folder.
 */
export async function readDirectory(target: StoreTarget, signal?: AbortSignal): Promise<Directory> {
  const entries = await listObjects(target, undefined, signal);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const records = new Map<string, FolderRecord>();
  const indexEntries = new Map<string, ObjectEntry>();
  const imageNames = new Map<string, string[]>();
  const foreignNames: string[] = [];

  for (const entry of entries) {
    const parts = parseObjectName(entry.name);
    if (parts === null) {
      foreignNames.push(entry.name);
      continue;
    }
    if (parts.kind === 'folder') {
      const text = await readTextOrNull(target, entry.name);
      // A folder record that cannot be read or parsed is NOT a folder: showing
      // it as one would mean guessing its owner and its privacy flag.
      const record = text === null ? null : parseJsonOrNull<FolderRecord>(text, folderRecordSchema);
      if (record !== null && record.slug === parts.slug) records.set(parts.slug, record);
      continue;
    }
    if (parts.kind === 'index') {
      indexEntries.set(parts.slug, entry);
      continue;
    }
    const list = imageNames.get(parts.slug) ?? [];
    list.push(entry.name);
    imageNames.set(parts.slug, list);
  }

  const folders: FolderListing[] = [];
  for (const [slug, record] of records) {
    const indexEntry = indexEntries.get(slug);
    let index: FolderIndex | null = null;
    if (indexEntry !== undefined) {
      const text = await readTextOrNull(target, indexEntry.name);
      index = text === null ? null : parseJsonOrNull<FolderIndex>(text, folderIndexSchema);
      if (index !== null && index.slug !== slug) index = null;
      /*
       * A STALE INDEX IS NOT AN INDEX EITHER. An index that parses but does not
       * cover every image the listing reports (or carries a different hash for
       * one — an object overwritten in place keeps its NAME) is treated exactly
       * like a missing one: `indexMissing` → the loud rebuild. Otherwise a
       * half-written or outdated index would quietly hide pictures the store
       * holds, which is the silent-loss failure this whole path exists to
       * prevent (docs/17 row 42).
       */
      if (index !== null && !indexCovers(index, imageNames.get(slug) ?? [], byName)) index = null;
    }
    folders.push({
      record,
      index,
      indexMissing: index === null,
      imageNames: (imageNames.get(slug) ?? []).slice().sort(),
    });
  }
  folders.sort((a, b) => a.record.slug.localeCompare(b.record.slug));
  return { entries, folders, foreignNames, byName };
}

/**
 * Rebuild ONE folder's index from the LISTING plus each image's own header.
 *
 * This is the loud rebuild path: it is what happens when the index is missing,
 * unparsable or does not cover every image object the listing reports. Each
 * image's header is validated with zod — a corrupt image object THROWS rather
 * than being dropped from the folder (rule 1: a folder that silently forgets an
 * image is worse than a loud failure).
 */
export async function rebuildIndex(
  target: StoreTarget,
  slug: string,
  imageNames: readonly string[],
  byName: ReadonlyMap<string, ObjectEntry>,
): Promise<FolderIndex> {
  const images: IndexImage[] = [];
  let maxSeq = 0;
  for (const name of [...imageNames].sort()) {
    const entry = byName.get(name);
    const text = await readTextOrNull(target, name);
    // Gone between the listing and the read: the listing is the authority on
    // what exists, so it is not indexed — and the next listing will not report
    // it either.
    if (text === null || entry === undefined) continue;
    const parsed = parseImageObject(text);
    if (parsed.folder !== slug) {
      throw new Error(
        `Stored image ${name} declares folder "${parsed.folder}" but its object name says "${slug}" — refusing to index an object whose name and header disagree.`,
      );
    }
    const parts = parseObjectName(name);
    if (parts !== null && parts.kind === 'image') {
      maxSeq = Math.max(maxSeq, Number(name.slice(name.lastIndexOf('-') + 1)));
    }
    // `sha256` and `size` come from the LISTING (the service's own facts about
    // the object), never from the decoded payload: a reader validating the
    // cache against this row must compare like with like.
    images.push({
      id: parsed.id,
      name,
      sha256: entry.sha256,
      size: entry.size,
      mimeType: parsed.mimeType,
      tags: parsed.tags,
      createdAt: parsed.createdAt,
    });
  }
  const index: FolderIndex = {
    v: OBJECT_VERSION,
    slug,
    nextSeq: maxSeq + 1,
    images,
  };
  await putObject(target, indexObjectName(slug), new TextEncoder().encode(JSON.stringify(index, null, 2)));
  return index;
}

/**
 * The index for a folder, rebuilt when it is missing or does not match the
 * listing. The comparison is by OBJECT NAME SET (not by hash) so a changed
 * image is caught as well as an added one.
 */
export async function ensureIndex(
  target: StoreTarget,
  listing: FolderListing,
  byName: ReadonlyMap<string, ObjectEntry>,
): Promise<{ index: FolderIndex; rebuilt: boolean }> {
  const current = listing.index;
  /**
   * An index is usable only when it covers EVERY image the listing reports AND
   * carries the listing's own hash for each — an object overwritten in place
   * keeps its name, so a name-set comparison alone would serve a stale entry
   * for ever.
   */
  if (current !== null && indexCovers(current, listing.imageNames, byName)) {
    return { index: current, rebuilt: false };
  }
  const rebuilt = await rebuildIndex(target, listing.record.slug, listing.imageNames, byName);
  return { index: rebuilt, rebuilt: true };
}

/**
 * Create a folder: write its RECORD, then its index.
 *
 * The record first, deliberately: the record is what makes a folder exist, and
 * an index without a record is an orphan this app ignores. A second writer
 * creating the same slug is refused by NAME (`store_exists` does not exist for
 * objects, so the check is the listing) rather than silently taking the folder
 * over.
 */
export async function createFolder(
  target: StoreTarget,
  input: { slug: string; displayName: string; private: boolean; who: WhoAmI },
  existingSlugs: readonly string[],
  now = new Date(),
): Promise<FolderRecord> {
  if (existingSlugs.includes(input.slug)) {
    throw new Error(`A folder named "${input.slug}" already exists in this store.`);
  }
  const stamp = now.toISOString();
  const record: FolderRecord = {
    v: OBJECT_VERSION,
    slug: input.slug,
    owner: input.who.id,
    displayName: input.displayName.trim() === '' ? input.slug : input.displayName.trim(),
    private: input.private,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await putObject(
    target,
    folderObjectName(input.slug),
    new TextEncoder().encode(JSON.stringify(folderRecordSchema.parse(record), null, 2)),
  );
  await putObject(
    target,
    indexObjectName(input.slug),
    new TextEncoder().encode(JSON.stringify(emptyFolderIndex(input.slug), null, 2)),
  );
  return record;
}

/**
 * Flip ONE folder's `private` flag. Only the RECORD is rewritten (read →
 * validate → write) — the index is untouched, because nothing about privacy
 * changes an image.
 */
export async function setFolderPrivate(
  target: StoreTarget,
  record: FolderRecord,
  isPrivate: boolean,
  now = new Date(),
): Promise<FolderRecord> {
  const next: FolderRecord = {
    ...folderRecordSchema.parse(record),
    private: isPrivate,
    updatedAt: now.toISOString(),
  };
  await putObject(
    target,
    folderObjectName(record.slug),
    new TextEncoder().encode(JSON.stringify(next, null, 2)),
  );
  return next;
}

/** One upload's outcome — the caller reports it PER FILE, never as a batch. */
export interface UploadResult {
  name: string;
  id: string;
  sha256: string;
  size: number;
  seq: number;
  /** True when a sequence collision was detected and the next free one used. */
  raced: boolean;
}

/**
 * Upload ONE image at FULL QUALITY (the owner's correction, docs/17 row 42).
 *
 * `bytes` are the source bytes EXACTLY: no resize, no re-encode, no quality
 * reduction. The store's own `sha256` is asserted against the bytes this app
 * computed, so "what was stored is what was uploaded" is verified rather than
 * assumed.
 *
 * ONE `PUT` writes the header and the bytes together, so an image can never
 * exist without its tags. `seq` comes from the index, and the listing is
 * re-checked per attempt — the API has no compare-and-swap, so this is the
 * honest best effort and the residual race is stated in the ledger.
 */
export async function uploadImage(
  target: StoreTarget,
  input: {
    slug: string;
    bytes: Uint8Array<ArrayBuffer>;
    mimeType: string;
    width: number;
    height: number;
    prompt: string;
    model: string;
    source: 'generated' | 'uploaded';
    /** The integer quality percent the payload was encoded at (docs/17 row 42). */
    quality: number;
    tags: readonly string[];
    id: string;
    createdAt: Date;
  },
  index: FolderIndex,
  knownNames: readonly string[],
): Promise<UploadResult> {
  if (input.bytes.length === 0) {
    throw new Error('Refusing to upload an empty file: the store never creates an empty object.');
  }
  const sha256 = await sha256Hex(input.bytes);
  const names = new Set(knownNames);
  let next = index.nextSeq;
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1) {
    const name = imageObjectName(input.slug, next);
    if (!names.has(name)) {
      const header: ImageHeader = {
        v: OBJECT_VERSION,
        id: input.id,
        folder: input.slug,
        tags: [...input.tags],
        prompt: input.prompt,
        model: input.model,
        source: input.source,
        createdAt: input.createdAt.toISOString(),
        width: input.width,
        height: input.height,
        mimeType: input.mimeType,
        quality: input.quality,
        sha256,
      };
      const body = new TextEncoder().encode(buildImageObject(header, input.bytes));
      const put = await putObject(target, name, body);
      /*
       * WHAT IS VERIFIED HERE: the service stored exactly the bytes this app
       * sent (its `sha256` is the hash of the WHOLE object — header plus
       * payload). The payload's own hash is what the header records and what
       * `collectDownloads` re-checks on the way out.
       */
      const sent = await sha256Hex(body);
      if (put.sha256 !== sent) {
        throw new Error(
          `The store reported sha256 ${put.sha256} for ${name}, but the bytes sent hash to ${sent} — refusing to record an upload whose stored content is not what was sent.`,
        );
      }
      const nextIndex: FolderIndex = {
        ...index,
        nextSeq: next + 1,
        images: [
          ...index.images,
          {
            id: input.id,
            name,
            sha256: put.sha256,
            size: put.size,
            mimeType: header.mimeType,
            tags: [...input.tags],
            createdAt: header.createdAt,
          },
        ],
      };
      await putObject(
        target,
        indexObjectName(input.slug),
        new TextEncoder().encode(JSON.stringify(folderIndexSchema.parse(nextIndex), null, 2)),
      );
      return {
        name,
        id: input.id,
        sha256: put.sha256,
        size: put.size,
        seq: next,
        raced: attempt > 0,
      };
    }
    next += 1;
  }
  throw new Error(
    `Could not find a free image sequence in folder "${input.slug}" after ${String(MAX_SEQ_ATTEMPTS)} attempts — another writer is uploading to it right now. Try again.`,
  );
}

/** ONE image object, read and validated. */
export async function readImageObject(
  target: StoreTarget,
  name: string,
): Promise<{ header: ImageHeader; bytes: Uint8Array<ArrayBuffer> }> {
  const text = await readTextOrNull(target, name);
  if (text === null) throw new Error(`Stored image ${name} is gone from the store.`);
  const parsed = parseImageObject(text);
  const parts = parseObjectName(name);
  if (parts?.kind !== 'image' || parts.slug !== parsed.folder) {
    throw new Error(
      `Stored image ${name} declares folder "${parsed.folder}", which its object name does not agree with — refusing to show a picture whose identity is ambiguous.`,
    );
  }
  const { body: _body, bytes, ...header } = parsed;
  return { header: imageHeaderSchema.parse(header), bytes };
}

/** The slug that is "mine" for one key: stored choice first, else the label. */
export function folderSlugForKey(who: WhoAmI, stored: string): string {
  if (stored !== '') {
    // A stored choice is used as-is when it is legal; an ILLEGAL one is an
    // error the owner must see, never silently replaced.
    return stored;
  }
  return slugFromLabel(who.label, slugFallbackForKey(who.id));
}

/**
 * The folders the app SHOWS for one identity.
 *
 * Honest semantics (docs/17 row 42): your own folder is always visible to you,
 * whoever wrote it; every other folder is shown unless its owner flagged it
 * private. That flag is a courtesy between users of this app — the server does
 * not enforce it and cannot.
 */
export function visibleFolders(
  folders: readonly FolderListing[],
  mySlug: string,
): FolderListing[] {
  return folders.filter(
    (folder) => folder.record.slug === mySlug || !folder.record.private,
  );
}
