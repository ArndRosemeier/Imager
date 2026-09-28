/**
 * THE ServerStore object model (docs/17 row 42): the exact name grammar, the
 * record shapes and the wire codec for one image.
 *
 * EVERYTHING LIVES IN ONE STORE (`imager`), namespaced by NAME — the owner's
 * decision: *"One shared store, namespaced by name."* The API has no
 * directories, no per-object permissions and only a `?prefix=` listing filter,
 * so the whole model is three object-name families:
 *
 *   folder-<slug>          the folder RECORD  { v, slug, owner, displayName, private, createdAt, updatedAt }
 *   folder-<slug>-index    the folder INDEX   { v, slug, nextSeq, images: [...] }
 *   i-<slug>-<seq>         ONE image          JSON header whose LAST field is the base64 bytes
 *
 * `slug` is a SINGLE segment `[a-z0-9._-]{1,40}` (no slashes exist in the API,
 * and no subfolders exist in this design).
 *
 * WHY THE FOLDER RECORD IS REQUIRED, NOT AN OPTIMISATION: ownership and the
 * privacy flag are NOT derivable from object names, and the API has no place
 * else to put them. A folder with no record is simply not a folder.
 *
 * WHY THE INDEX IS AN OPTIMISATION: it makes the folder dialog cheap (one read
 * instead of one read per image) and it is REBUILDABLE — a missing or
 * corrupt index is rebuilt from the listing plus each image's own header, never
 * shown as an empty folder (see `store-folders.ts`).
 *
 * METADATA-IN-BYTES (the decided encoding; the alternative was a container
 * format with a length-prefixed header):
 *  * A JSON header whose LAST field is the base64 payload. ONE `PUT` writes
 *    metadata and pixels together, so an image can never exist without its
 *    tags — the reason the brief gives for this shape, kept.
 *  * Base64 rather than a byte-exact header/body split because the app already
 *    owns ONE tested base64 seam (`src/lib/base64.ts`) and a hand-invented
 *    container format would be a second, untested parser of our own making. The
 *    cost is +33% on the wire and a full decode to render; the store's body cap
 *    is 64 MiB and every image is downscaled to <= `REFERENCE_MAX_EDGE_PX`, so
 *    the cost is bounded and stated rather than hidden.
 *  * The payload is found WITHOUT a JSON parse of the whole object: base64
 *    never contains a quote or a newline, so the reader anchors on the last
 *    `\n  "body": "` and validates the head with zod at the boundary.
 */
import { z } from 'zod';

import { base64FromBytes, bytesFromBase64 } from '@/lib/base64';

/** The object-name prefix for a folder record. */
export const FOLDER_PREFIX = 'folder-';
/** The object-name prefix for one image. */
export const IMAGE_PREFIX = 'i-';
/** The suffix that turns a folder record's name into its index's name. */
export const INDEX_SUFFIX = '-index';

/**
 * The folder slug grammar: ONE segment, no slashes, no subfolders.
 *
 * The API's own rule for a name is `[a-z0-9][a-z0-9._-]{0,63}` — the FIRST
 * character must be a letter or digit (a leading `.` is refused, so `.hidden`
 * is not a name), which is why the pattern below is not symmetric.
 */
export const SLUG_MAX_CHARS = 40;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** The sequence is zero-padded to six digits, so names sort in upload order. */
export const SEQ_DIGITS = 6;

/** The format version carried by every record this app writes. */
export const OBJECT_VERSION = 1;

export type ObjectKind = 'folder' | 'index' | 'image';

/* ------------------------------------------------------------------- names */

/** The folder RECORD's object name. The slug is validated, never sanitised
 * into a different name (the API refuses `400 invalid_name` instead). */
export function folderObjectName(slug: string): string {
  assertSlug(slug);
  return `${FOLDER_PREFIX}${slug}`;
}

/** The folder INDEX's object name. */
export function indexObjectName(slug: string): string {
  assertSlug(slug);
  return `${FOLDER_PREFIX}${slug}${INDEX_SUFFIX}`;
}

/** ONE image's object name. */
export function imageObjectName(slug: string, seq: number): string {
  assertSlug(slug);
  return `${IMAGE_PREFIX}${slug}-${formatSeq(seq)}`;
}

/** `7` → `000007`. */
export function formatSeq(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq >= 10 ** SEQ_DIGITS) {
    throw new Error(`Image sequence ${String(seq)} is outside the 1..${String(10 ** SEQ_DIGITS - 1)} range the six-digit name grammar allows.`);
  }
  return String(seq).padStart(SEQ_DIGITS, '0');
}

function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `"${slug}" is not a legal folder slug: a folder is ONE segment of 1-${String(SLUG_MAX_CHARS)} characters from a-z 0-9 . _ - (no slashes, no spaces, no uppercase).`,
    );
  }
}

/** What one object name IS, so a listing can be partitioned without guessing. */
export interface ObjectNameParts {
  kind: ObjectKind;
  /** Present for `folder` and `index`; the folder the image belongs to for `image`. */
  slug: string;
}

/**
 * Classify one object name, or `null` for a name this app did not write.
 *
 * Slack is deliberate — the store is shared by key holders and the owner's
 * "honour based" privacy answer means anyone may have put something else in
 * it. An unparsable name is IGNORED, never reported as a corrupt folder.
 */
export function parseObjectName(name: string): ObjectNameParts | null {
  if (name.startsWith(FOLDER_PREFIX)) {
    const rest = name.slice(FOLDER_PREFIX.length);
    if (rest.endsWith(INDEX_SUFFIX)) {
      const slug = rest.slice(0, -INDEX_SUFFIX.length);
      return SLUG_PATTERN.test(slug) ? { kind: 'index', slug } : null;
    }
    return SLUG_PATTERN.test(rest) ? { kind: 'folder', slug: rest } : null;
  }
  if (name.startsWith(IMAGE_PREFIX)) {
    const rest = name.slice(IMAGE_PREFIX.length);
    const separator = rest.lastIndexOf('-');
    if (separator <= 0) return null;
    const slug = rest.slice(0, separator);
    const seq = rest.slice(separator + 1);
    if (!SLUG_PATTERN.test(slug) || !/^\d{6}$/.test(seq)) return null;
    return { kind: 'image', slug };
  }
  return null;
}

/* ----------------------------------------------------------------- objects */

/**
 * ONE folder record. `owner` is an HONOUR-BASED label (the `whoami` id), not an
 * ACL: the API has no per-object permissions, so the app can only describe who
 * wrote a folder, never prevent anyone else from writing it (docs/17 row 42).
 */
export const folderRecordSchema = z.strictObject({
  v: z.literal(OBJECT_VERSION),
  slug: z.string().regex(SLUG_PATTERN),
  /** The key id that created the folder (from `GET /whoami`). */
  owner: z.string(),
  /** The key's label, for a human reading the folder list. */
  displayName: z.string(),
  /**
   * The owner's HONOUR-BASED privacy choice. Every client of this app hides a
   * private folder from the "public folders" view; the SERVER does not, and
   * cannot — any key scoped to this store can still read every object.
   */
  private: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FolderRecord = z.infer<typeof folderRecordSchema>;

/** One image's metadata, exactly as stored in its own object's JSON header. */
export const imageHeaderSchema = z.strictObject({
  v: z.literal(OBJECT_VERSION),
  /** The app's own id for the image; unique inside the object it lives in. */
  id: z.string().min(1),
  /** The folder slug. Cross-checked against the object NAME on read. */
  folder: z.string().regex(SLUG_PATTERN),
  tags: z.array(z.string()),
  prompt: z.string(),
  model: z.string(),
  source: z.enum(['generated', 'uploaded']),
  createdAt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * The payload's MIME type. The store holds WebP at the recorded quality
   * (docs/17 row 42), or PNG when a browser cannot encode WebP — the value is
   * the encoder's ACTUAL output type, verified before it was written, never an
   * assumption.
   */
  mimeType: z.string().min(1),
  /**
   * The lossy quality the payload was encoded at, as an integer percent
   * (90 for the default `High`). Recorded per image so a reader knows what it
   * is looking at; a later change to the app's quality setting NEVER re-encodes
   * an image that is already stored.
   */
  quality: z.number().int().min(1).max(100),
  /**
   * The hex SHA-256 of the PAYLOAD BYTES below.
   *
   * Optional ON PURPOSE: it is a convenience copy of what the listing already
   * reports (`GET …/objects` returns every object's `sha256`), and the listing
   * is what the cache is validated against. It is written so the header alone
   * is self-describing, never read as the integrity authority.
   */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * The hex SHA-256 of the SOURCE bytes this payload was encoded FROM — the
   * identity that survives the re-encode (docs/17 row 45).
   *
   * WHY THIS FIELD EXISTS AND `sha256` ABOVE CANNOT DO ITS JOB: the store holds
   * WebP q90, so a local PNG/JPEG never hash-matches the stored payload, and the
   * object's own sha256 (the listing's, over header+payload) can never be
   * recomputed locally because the header carries a fresh `id`. Comparing
   * `sha256(local bytes)` with either of those would report "not there" for
   * every image for ever. The source identity is recorded HERE, at push time,
   * by the ONE uploader (`uploadSources`), and it is the value a viewer's
   * "already in the store" check compares against — deterministically, with no
   * re-encode, no heuristic and no dependence on which browser encoded the
   * payload.
   *
   * It is also the identity the app ALREADY uses for a local image: the export
   * manifest carries the same `sha256(bytes)` (`src/lib/sha256.ts`, the ONE
   * hashing seam), so the store's notion of "the same picture" and the archive's
   * agree instead of being a second, divergent one.
   *
   * Optional ON PURPOSE: an object written before this field existed (or by
   * another client) simply carries no source identity, and a reader must treat
   * that as "cannot tell", never as a match.
   */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type ImageHeader = z.infer<typeof imageHeaderSchema>;

/** The wire shape: the header fields plus the base64 payload LAST. */
export const imageObjectSchema = imageHeaderSchema.extend({
  body: z.string().min(1),
});
export type ImageObject = z.infer<typeof imageObjectSchema>;

/** One parsed image object: the stored wire shape plus the DECODED payload. */
export interface ParsedImageObject extends ImageObject {
  bytes: Uint8Array<ArrayBuffer>;
}

/** The separator the reader anchors on (see the file header for why it is safe). */
const BODY_KEY = '\n  "body": "';

/**
 * ONE image object: the validated header followed by the payload as the LAST
 * field. The header is validated BEFORE serialising, so a malformed object
 * cannot be written. The payload is `Object.keys()`-last by construction, and
 * the pin in `tests/server/store-files.test.ts` asserts the round trip byte for
 * byte.
 */
export function buildImageObject(header: ImageHeader, bytes: Uint8Array<ArrayBuffer>): string {
  const checked = imageHeaderSchema.safeParse(header);
  if (!checked.success) {
    throw new Error(`Refusing to write a malformed image header: ${checked.error.message}`);
  }
  const parsed = checked.data;
  if (bytes.length === 0) {
    throw new Error('Refusing to store an empty image payload: the store never creates an empty object, and an empty PNG is not a picture.');
  }
  // JSON.stringify with an indent gives the exact text the reader expects; the
  // payload is spliced in as the last field so no base64 byte is ever escaped.
  const withoutBody = JSON.stringify({ ...parsed, body: '' }, null, 2);
  const marker = `"body": ""`;
  const at = withoutBody.lastIndexOf(marker);
  if (at < 0) {
    throw new Error('Internal error building the image object: the body field did not survive serialisation.');
  }
  return `${withoutBody.slice(0, at)}"body": "${base64FromBytes(bytes)}"\n}`;
}

/**
 * Parse ONE image object. The header is validated with zod; the payload is
 * decoded through the app's ONE base64 seam. ANY failure is a loud error
 * (rule 1/3) — a corrupt image object is never rendered as a broken picture.
 */
export function parseImageObject(text: string): ParsedImageObject {
  const at = text.lastIndexOf(BODY_KEY);
  if (at < 0) {
    throw new Error(
      'Stored image object is corrupt: it carries no trailing base64 "body" field (the field this app writes LAST).',
    );
  }
  // The slice stops just before `"body"`, so the PREVIOUS property still ends
  // with its comma; JSON has no trailing commas, so it goes.
  const head = `${text.slice(0, at).replace(/,\s*$/, '')}\n}`;
  let header: unknown;
  try {
    header = JSON.parse(head) as unknown;
  } catch (error) {
    throw new Error(`Stored image object is corrupt: its header is not JSON.`, { cause: error });
  }
  const parsedHeader = imageHeaderSchema.safeParse(header);
  if (!parsedHeader.success) {
    throw new Error(`Stored image object is corrupt: ${parsedHeader.error.message}`);
  }
  const bodyText = text.slice(at + BODY_KEY.length);
  const closing = bodyText.lastIndexOf('"');
  if (closing < 0) {
    throw new Error('Stored image object is corrupt: its base64 body is unterminated.');
  }
  const base64: string = bodyText.slice(0, closing);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = bytesFromBase64(base64);
  } catch (error) {
    throw new Error('Stored image object is corrupt: its base64 body does not decode.', {
      cause: error,
    });
  }
  if (bytes.length === 0) {
    throw new Error('Stored image object is corrupt: its base64 body decoded to zero bytes.');
  }
  const parsedObject: ParsedImageObject = { ...parsedHeader.data, body: base64, bytes };
  return parsedObject;
}

/** One image as the folder index carries it: the header plus the listing facts. */
export const indexImageSchema = z.strictObject({
  id: z.string().min(1),
  /** The OBJECT name, so a reader never re-derives it. */
  name: z.string().min(1),
  /** The store's own sha256 for that object (from the listing). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The stored byte length reported by the listing. */
  size: z.number().int().nonnegative(),
  /**
   * The PICTURE's MIME type, from the object's own header. Carried here so a
   * reader can name a download (its extension) without opening every object —
   * the index is the cheap view, and a missing field would force a fetch per
   * file just to learn a suffix.
   */
  mimeType: z.string().min(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  /**
   * The SOURCE identity from the image's own header — carried here so the
   * viewer's "is this already in the store?" check costs ONE listing + the
   * folder indexes instead of a fetch per object (docs/17 row 45). Absent for an
   * object written before the field existed: a reader must say it cannot tell
   * rather than guess.
   */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type IndexImage = z.infer<typeof indexImageSchema>;

/**
 * ONE folder index. It is a DERIVED view (rebuildable from the listing plus
 * each image's header) and it is never trusted for existence: a missing or
 * unparsable index triggers a rebuild (docs/17 row 42).
 */
export const folderIndexSchema = z.strictObject({
  v: z.literal(OBJECT_VERSION),
  slug: z.string().regex(SLUG_PATTERN),
  /** The next free sequence. Monotonic on the happy path; collisions are
   * detected against the listing (the API has no compare-and-swap). */
  nextSeq: z.number().int().positive(),
  images: z.array(indexImageSchema),
});
export type FolderIndex = z.infer<typeof folderIndexSchema>;

/** A freshly created folder's index: no images, first sequence free. */
export function emptyFolderIndex(slug: string): FolderIndex {
  assertSlug(slug);
  return { v: OBJECT_VERSION, slug, nextSeq: 1, images: [] };
}

/* ------------------------------------------------------------- slug source */

/**
 * A folder slug from a `whoami` label (or any owner-typed name).
 *
 * This is an OUTPUT ENCODER, not a parser (AGENTS rule 5): it maps arbitrary
 * text onto the character contract a name has, exactly as `sanitizeFileName`
 * does for file names. It reads no meaning out of the text.
 *
 * `fallback` is used when nothing survives (an empty or all-symbol label), and
 * it is itself encoded, so the result is never empty and never illegal.
 */
export function slugFromLabel(label: string, fallback: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/[.-]+$/, '');
  if (SLUG_PATTERN.test(slug)) return slug;
  const safeFallback = fallback
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/[.-]+$/, '');
  if (SLUG_PATTERN.test(safeFallback)) return safeFallback;
  throw new Error(
    `Could not derive a folder name from "${label}" (and the fallback "${fallback}" is not usable either): a folder name must start with a letter or digit and contain only a-z 0-9 . _ -`,
  );
}

/** A stable fallback slug for a key whose label carries nothing usable. */
export function slugFallbackForKey(keyId: string): string {
  const id = keyId.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `user-${id.slice(0, 12) === '' ? 'key' : id.slice(0, 12)}`;
}
