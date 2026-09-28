/**
 * THE "add this image to the store" seam (docs/17 row 48): the check that
 * answers "is this LOCAL picture already in the store?" and the ONE push the
 * image viewer's button performs.
 *
 * THE OWNER'S ASK, verbatim: *"There should also be a button in the image
 * viewer to just add this to the store if its not already there, for
 * convenience."* The button is one convenience action; the substantive half is
 * the "if it's not already there".
 *
 * WHY THE OBVIOUS CHECK IS WRONG. The store holds WebP q90 (`store-encode.ts`),
 * so a local PNG/JPEG's bytes are never the stored bytes. Comparing
 * `sha256(local bytes)` with either of the store's own hashes reports "not
 * there" for EVERY image for ever:
 *  * the listing's `sha256` covers the WHOLE object (header + payload) and the
 *    header carries a fresh `id`, so it is not recomputable from anything local;
 *  * the header's `sha256` is the PAYLOAD's, which the re-encode replaces.
 * The identity therefore has to be recorded NEXT TO the picture at push time:
 * `sourceSha256` — the SHA-256 of the ORIGINAL bytes the payload was encoded
 * from (docs/17 row 45, computed once in `uploadSources`, the ONE uploader, and
 * carried by the object header and the folder index). It survives the re-encode
 * by construction, it is deterministic (no heuristic, no candidate scoring, no
 * browser-dependent re-encode comparison), and it is the SAME `sha256(bytes)`
 * the export manifest already uses (`src/lib/sha256.ts`, the ONE hashing seam) —
 * so the store's notion of "the same picture" and the app's own agree.
 *
 * THE CHECK IS READ-ONLY, ALWAYS. It is ONE directory read (the listing plus
 * every folder's index) and one hash of the local bytes; it never rebuilds an
 * index, never writes, and never fetches an object. A folder whose index is
 * missing or stale is a stated "cannot tell" — the store tab owns the rebuild
 * (its "Rebuild now" door) — because a read path that silently writes is a
 * surprise the owner did not ask for.
 *
 * THE DESTINATION IS THE KEY'S OWN FOLDER, deliberately NOT "the folder open in
 * the store pane" (which is the library PICKER's rule, docs/17 row 45). A viewer
 * button has no pane beside it: it cannot show which folder happens to be open
 * there, so a destination that depended on that hidden state would put pictures
 * somewhere the owner did not choose and could not see. His own folder is the
 * one destination the app can name and justify on the spot.
 *
 * THE PUSH ITSELF IS THE EXISTING ONE: this module calls the library adapter
 * `uploadStoredImages` (a one-image batch), so the encoder, the object model and
 * the index update are the SAME code the picker and the device upload use. There
 * is no third uploader and no second adapter to drift (rule 4; the "two entry
 * points share ONE uploader" pin in `tests/architecture/one-store-source.test.ts`
 * stays green because this adds no `uploadSources(` call site).
 */
import type { StoredImage } from '@/domain/image';
import { uploadStoredImages, type UploadProgress } from '@/features/store/storeTransfer';
import { sha256Hex } from '@/lib/sha256';
import { readDirectory, visibleFolders } from '@/server/store-folders';
import { connectStored, type StoreConnection } from '@/server/store-session';

/**
 * What the viewer's button must be able to say. Every arm is EXPLAINABLE: there
 * is no "unknown" that renders as an offered push.
 *
 *  * `unconfigured`  — no key on this browser. Everything else in Imager works.
 *  * `unreachable`   — a key exists but `/whoami` (or the listing) refused or failed.
 *  * `no-folder`     — the key works and has no folder RECORD in the store yet.
 *  * `already`       — a `sourceSha256` match. `visible: false` means the match
 *                      is in a folder outside `visibleFolders` (another key's
 *                      private folder): reported honestly, but UNNAMED.
 *  * `cannot-tell`   — a folder's index is missing or stale, so a duplicate
 *                      cannot be ruled out. Never guessed away.
 *  * `ready`         — nothing matched and the destination exists.
 */
export type StorePushAvailability =
  | { status: 'unconfigured' }
  | { status: 'unreachable'; error: unknown }
  | { status: 'no-folder'; myFolder: string }
  | { status: 'already'; objectName: string; folderLabel: string; visible: boolean }
  | { status: 'cannot-tell'; reason: string }
  | {
      status: 'ready';
      connection: StoreConnection;
      folderSlug: string;
      folderLabel: string;
    };

/** The one arm a push can run from. */
export type ReadyStorePush = Extract<StorePushAvailability, { status: 'ready' }>;

/** What a completed push reports, for a confirmation that names where it landed. */
export interface StorePushResult {
  /** The store object name the picture became (`i-<slug>-<seq>`). */
  objectName: string;
  /** The folder's display name, as the owner reads it. */
  folderLabel: string;
}

/** The capability the image viewer is handed. Present → the lightbox offers it. */
export interface StorePushApi {
  /** Read-only: is this local picture already in the store? */
  inspect: (image: StoredImage) => Promise<StorePushAvailability>;
  /** Push ONE local picture through the ONE uploader. Rejects with the store's reason. */
  push: (
    image: StoredImage,
    ready: ReadyStorePush,
    onProgress?: (progress: UploadProgress) => void,
  ) => Promise<StorePushResult>;
}

/**
 * The identity of a LOCAL picture, in the store's own terms: the SHA-256 of its
 * original bytes — exactly the value `uploadSources` records as `sourceSha256`
 * when it pushes the same row (both go through `src/lib/sha256.ts`, and
 * `imageBlob` hands the uploader the row's bytes untouched).
 */
export async function sourceIdentityOf(image: StoredImage): Promise<string> {
  return sha256Hex(image.bytes);
}

/**
 * Is this picture already in the store, and if not, may it be pushed?
 *
 * ONE `GET /whoami` (only when a key is configured — an unconfigured app makes
 * NO request at all), ONE listing and the folder indexes that listing points at.
 * Nothing is written and no image object is fetched.
 */
export async function inspectStorePush(image: StoredImage): Promise<StorePushAvailability> {
  const state = await connectStored();
  if (state.status === 'unconfigured') return { status: 'unconfigured' };
  if (state.status === 'failed') return { status: 'unreachable', error: state.error };
  if (state.status === 'connecting') {
    throw new Error(
      'The store session reported "connecting" outside a connection attempt — refusing to guess whether the store is usable.',
    );
  }
  const { connection } = state;
  const directory = await readDirectory(connection.target);
  const identity = await sourceIdentityOf(image);

  /*
   * The match is over EVERY folder the listing reports an index for — including
   * one another key flagged private — because the question is "would a push
   * create a duplicate?", and the app is the only reader here: it compares an
   * opaque hash and never shows that folder's contents. What it must NOT do is
   * pretend it can see a folder it hides, so the match is reported by name only
   * when the folder is in `visibleFolders` (the ONE place the honour-based
   * privacy rule is applied).
   */
  const visibleSlugs = new Set(
    visibleFolders(directory.folders, connection.myFolder).map((folder) => folder.record.slug),
  );
  for (const folder of directory.folders) {
    const hit = folder.index?.images.find((entry) => entry.sourceSha256 === identity);
    if (hit !== undefined) {
      const visible = visibleSlugs.has(folder.record.slug);
      return {
        status: 'already',
        objectName: hit.name,
        folderLabel: visible ? folder.record.displayName : 'a folder that is not visible to you',
        visible,
      };
    }
  }

  const mine = directory.folders.find((folder) => folder.record.slug === connection.myFolder);
  if (mine === undefined) return { status: 'no-folder', myFolder: connection.myFolder };

  /*
   * An index-less folder is the one honest blind spot. It is NOT rebuilt here:
   * a check that writes would surprise the owner, and the store tab already owns
   * that door. Saying "I cannot tell" is the only answer that never offers a
   * duplicate and never claims a certainty the data does not carry.
   */
  if (directory.folders.some((folder) => folder.index === null)) {
    return {
      status: 'cannot-tell',
      reason:
        'Cannot tell whether this image is already in the store: at least one folder there has no readable index yet. Open the Store tab — it rebuilds a folder index when it needs to — and try again. Nothing was uploaded.',
    };
  }

  return {
    status: 'ready',
    connection,
    folderSlug: mine.record.slug,
    folderLabel: mine.record.displayName,
  };
}

/**
 * Push ONE local picture into its folder, through the library adapter over the
 * ONE uploader (`uploadStoredImages` → `uploadSources`). The quality is the
 * owner's default `High` (WebP q90, full pixel size): the folder dialog's
 * quality switch is PER BATCH and lives in that dialog, so the viewer must not
 * pretend to know it — and it must not silently inherit a setting chosen for
 * some other upload either.
 *
 * A per-picture failure is a THROW with the uploader's own message (which keeps
 * a `429`'s `Retry-After` and the service's `413`/`403` reason verbatim), so the
 * caller's single failure surface is the toast seam (rule 2) and the button
 * cannot report a push that did not happen.
 */
export async function pushImageToStore(
  image: StoredImage,
  ready: ReadyStorePush,
  onProgress: (progress: UploadProgress) => void = () => undefined,
): Promise<StorePushResult> {
  const results = await uploadStoredImages(
    ready.connection,
    ready.folderSlug,
    [image],
    onProgress,
  );
  const row = results[0];
  if (row === undefined) {
    throw new Error(
      'The store upload reported no result for this image — refusing to confirm a push nobody can account for.',
    );
  }
  if (row.phase === 'failed') {
    throw new Error(row.error ?? 'The store refused this image.');
  }
  if (row.name === undefined) {
    throw new Error(
      'The store accepted this image but reported no object name — refusing to confirm a push whose object cannot be named.',
    );
  }
  return { objectName: row.name, folderLabel: ready.folderLabel };
}

/** The ONE instance the app shell hands the gallery (see the gallery mount in the app shell). */
export const storePushApi: StorePushApi = {
  inspect: inspectStorePush,
  push: pushImageToStore,
};
