/**
 * THE ServerStore local-cache seam (docs/17 row 42).
 *
 * WHAT IS CACHED, and why it is TWO tables:
 *
 *  * `storeThumbs` — the THUMBNAIL derived from an image, keyed by object name
 *    and validated by the store's own `sha256`. This is what the folder browser
 *    paints; it is the only thing the grid needs.
 *  * `storeObjects` — the whole stored OBJECT (the JSON header plus the base64
 *    payload), byte for byte as the service served it, keyed by object name and
 *    validated by the same `sha256`. A thumbnail is derived from the payload
 *    INSIDE it, so a re-derivation after a change needs the object anyway, and
 *    a download has no other source that is byte-identical to the store.
 *
 * A LISTING THAT REPORTS A DIFFERENT `sha256` INVALIDATES BOTH: a cached row
 * carries the hash it was stored under, and `readValid*` refuses (and deletes)
 * a row whose hash is not the one the listing just reported. The change is
 * detected from the ONE listing call — no timestamps are compared anywhere.
 *
 * THE OBJECT IS SELF-DESCRIBING, AND THIS MODULE USES IT: the picture's MIME
 * type, its pixel size and its tags come from the object's OWN header, never
 * from a caller's opinion (a download's file extension and a cache row's label
 * therefore cannot drift from what is stored).
 *
 * THE CACHE IS AN OPTIMISATION: with an empty cache every path still works (it
 * refetches), and the derived thumbnail is reproducible from the object.
 */
import { db } from '@/db/db';
import { encodeThumbnail } from '@/server/store-encode';
import { parseImageObject, parseObjectName } from '@/server/store-files';
import { getObject, type StoreTarget } from '@/server/store-client';

/** One cached thumbnail. `sha256` is the hash of the OBJECT it came from. */
export interface CachedThumbnail {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * One image as the store holds it. `objectBytes` is the WHOLE object (what the
 * service serves); `bytes`/`mimeType`/`width`/`height` are the picture inside
 * it, taken from its own header.
 */
export interface CachedOriginal {
  objectBytes: Uint8Array<ArrayBuffer>;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  width: number;
  height: number;
  tags: string[];
  prompt: string;
  /** The payload's own recorded hash, which the header carries. */
  payloadSha256: string | null;
}

/**
 * The cached thumbnail for `name`, or `null` when nothing is cached or the
 * cached row was derived from a different version of the object. `sha256` is
 * the hash the CURRENT listing reports: a mismatch is exactly "the image
 * changed on the server", and it invalidates the row.
 */
export async function readValidThumbnail(
  name: string,
  sha256: string,
): Promise<CachedThumbnail | null> {
  const row = await db.storeThumbs.get(name);
  if (row === undefined) return null;
  if (row.sha256 !== sha256) {
    // The object changed server-side: the derived thumbnail is stale. Deleting
    // it here (rather than leaving it for a later sweep) is what makes the
    // invalidation observable and keeps the DB from growing dead rows.
    await db.storeThumbs.delete(name);
    return null;
  }
  return { bytes: row.bytes, mimeType: row.mimeType, width: row.width, height: row.height };
}

/** The cached OBJECT for `name` (parsed from its own header), or `null`. */
export async function readValidOriginal(
  name: string,
  sha256: string,
): Promise<CachedOriginal | null> {
  const row = await db.storeObjects.get(name);
  if (row === undefined) return null;
  if (row.sha256 !== sha256) {
    await db.storeObjects.delete(name);
    return null;
  }
  return imageFromObject(name, row.bytes);
}

/**
 * Parse a whole stored object into the picture it holds, and check that the
 * object's OWN header agrees with the OBJECT NAME it lives under — an object
 * whose identity is ambiguous is a loud failure, never a shown picture.
 */
function imageFromObject(name: string, objectBytes: Uint8Array<ArrayBuffer>): CachedOriginal {
  const parsed = parseImageObject(new TextDecoder().decode(objectBytes));
  const parts = parseObjectName(name);
  if (parts?.kind !== 'image' || parts.slug !== parsed.folder) {
    throw new Error(
      `Stored image ${name} declares folder "${parsed.folder}", which its object name does not agree with — refusing to show a picture whose identity is ambiguous.`,
    );
  }
  return {
    objectBytes,
    bytes: parsed.bytes,
    mimeType: parsed.mimeType,
    width: parsed.width,
    height: parsed.height,
    tags: parsed.tags,
    prompt: parsed.prompt,
    payloadSha256: parsed.sha256 ?? null,
  };
}

/**
 * Derive a browser thumbnail from the picture the store holds — never from a
 * downsized copy that came from the store, and never from a local re-encode of
 * the source file. The resize happens HERE and nowhere else: the stored object
 * keeps its full pixel size (docs/17 row 42).
 */
export async function deriveThumbnail(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): Promise<CachedThumbnail> {
  return encodeThumbnail(new Blob([bytes], { type: mimeType }));
}

/** Store one derived thumbnail against the OBJECT's hash. */
export async function writeThumbnail(
  name: string,
  sha256: string,
  thumbnail: CachedThumbnail,
): Promise<void> {
  await db.storeThumbs.put({
    name,
    sha256,
    bytes: thumbnail.bytes,
    mimeType: thumbnail.mimeType,
    width: thumbnail.width,
    height: thumbnail.height,
    cachedAt: Date.now(),
  });
}

/** Store the whole object against the service's own hash for it. */
export async function writeOriginal(
  name: string,
  sha256: string,
  objectBytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const image = imageFromObject(name, objectBytes);
  await db.storeObjects.put({
    name,
    sha256,
    bytes: objectBytes,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    cachedAt: Date.now(),
  });
}

/** Forget everything cached for one object (the object and its thumbnail). */
export async function forgetObject(name: string): Promise<void> {
  await Promise.all([db.storeThumbs.delete(name), db.storeObjects.delete(name)]);
}

export interface ServeOptions {
  /** The hash the CURRENT listing reports for this object. */
  sha256: string;
  signal?: AbortSignal | undefined;
}

/**
 * The picture one object holds: from the cache when the cached row matches the
 * listing's hash, otherwise fetched and cached. The service's own
 * `x-serverstore-sha256` is checked against the listing's hash, so "the store
 * served me what the listing said it would" is VERIFIED, not assumed — a
 * mismatch is a loud error rather than a silently accepted object.
 */
export async function fetchOriginal(
  target: StoreTarget,
  name: string,
  options: ServeOptions,
): Promise<CachedOriginal> {
  const cached = await readValidOriginal(name, options.sha256);
  if (cached !== null) return cached;
  const fetched = await getObject(target, name, options.signal);
  if (fetched.sha256 !== options.sha256) {
    throw new Error(
      `The store changed ${name} while it was being read: the listing reported ${options.sha256} but the object returned ${fetched.sha256}. Refresh the folder and try again.`,
    );
  }
  const image = imageFromObject(name, fetched.bytes);
  await writeOriginal(name, options.sha256, fetched.bytes);
  return image;
}

/**
 * The thumbnail for one object: the cached one when its hash matches the
 * listing, otherwise re-derived from the picture's own bytes — which are
 * themselves fetched (and cached) when the change invalidated them.
 */
export async function serveThumbnail(
  target: StoreTarget,
  name: string,
  options: ServeOptions,
): Promise<CachedThumbnail> {
  const cached = await readValidThumbnail(name, options.sha256);
  if (cached !== null) return cached;
  const original = await fetchOriginal(target, name, options);
  const derived = await deriveThumbnail(original.bytes, original.mimeType);
  await writeThumbnail(name, options.sha256, derived);
  return derived;
}

/** How much the cache holds, for the Settings row's honest line. */
export async function storeCacheStats(): Promise<{
  objects: number;
  thumbs: number;
  bytes: number;
}> {
  const [rows, thumbs] = await Promise.all([db.storeObjects.toArray(), db.storeThumbs.toArray()]);
  return {
    objects: rows.length,
    thumbs: thumbs.length,
    bytes:
      rows.reduce((total, row) => total + row.bytes.length, 0) +
      thumbs.reduce((total, row) => total + row.bytes.length, 0),
  };
}

export async function clearStoreCache(): Promise<void> {
  await db.transaction('rw', db.storeObjects, db.storeThumbs, async () => {
    await db.storeObjects.clear();
    await db.storeThumbs.clear();
  });
}
