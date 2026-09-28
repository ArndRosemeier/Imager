/**
 * THE ServerStore upload and download flows (docs/17 row 42).
 *
 * UPLOADS ARE RE-ENCODED TO WEBP, NOT RESIZED (the owner's FINAL format
 * decision, docs/17 row 42): the same pixels at the same size, compressed at
 * the chosen quality (default High = 90). This deliberately REPLACES the
 * earlier "byte for byte" rule — the store hands back the same picture, not the
 * identical file — and the UI says so where a reader might expect his exact
 * file back. The encoder's output type is VERIFIED (`store-encode.ts`), so a
 * browser that silently substitutes another format fails loudly instead of
 * storing a mislabelled object.
 *
 * DOWNLOADS ARE THE STORE'S OWN BYTES: each object is fetched and checked
 * against the listing's `sha256` before it is saved, so "what I downloaded is
 * what the store holds" is verified rather than assumed. One image saves as
 * itself; a multi-selection saves as ONE zip through the export seam's
 * `buildFilesArchive` (the app's ONE `zipSync` site).
 *
 * THE 64 MiB CAP IS BOTH REAL AND UNLIKELY: `SERVERSTORE_MAX_BYTES` is 64 MiB
 * per request, and WebP q90 at screen resolutions is far below it — but a stray
 * huge upload still fails HONESTLY, per file, with the service's own
 * `payload_too_large` message, and the batch continues. Nothing is ever
 * downscaled to fit.
 *
 * TWO ENTRY POINTS, ONE UPLOADER (docs/17 row 45): a file from this device
 * (`uploadFiles`) and an image from the LOCAL gallery (`uploadStoredImages`)
 * both become `UploadSource`s and go through `uploadSources` — ONE encoder, ONE
 * object model, ONE index update. A `429` keeps its `Retry-After` in the failed
 * row instead of being retried silently (a retried write could double-upload).
 */
import {
  UPLOADED_IMAGE_MODEL,
  extensionFor,
  imageBlob,
  type ImageSource,
  type StoredImage,
} from '@/domain/image';
import {
  ARCHIVE_MIME_TYPE,
  buildFilesArchive,
  sanitizeFileName,
  timestampedArchiveName,
} from '@/features/export/exportLibrary';
import { saveFile, type SaveOutcome, type SaveRequest } from '@/lib/saveFile';
import { sha256Hex } from '@/lib/sha256';
import { toastSuccess } from '@/lib/toast';
import { fetchOriginal } from '@/server/store-cache';
import { DEFAULT_STORE_QUALITY, encodeStoreImage, type StoreQuality } from '@/server/store-encode';
import { ServerStoreError } from '@/server/store-errors';
import { ensureIndex, readDirectory, uploadImage } from '@/server/store-folders';
import type { StoreConnection } from '@/server/store-session';

/** One upload's progress, reported PER PICTURE and never as a batch only. */
export type UploadPhase = 'pending' | 'reading' | 'uploading' | 'done' | 'failed';

export interface UploadProgress {
  /**
   * A stable identity for THIS picture inside the batch, so the progress list
   * can replace one row without collapsing two pictures that happen to share a
   * label (two library images can carry the same prompt). Display code must not
   * derive it: it is the uploader's own key.
   */
  key: string;
  /**
   * What the owner reads on the progress row: a device file's NAME, or a
   * library image's PROMPT. It is the recognisable label of the thing being
   * pushed, not necessarily a file name.
   */
  label: string;
  phase: UploadPhase;
  /** The store object name, once it exists. */
  name?: string;
  /** The reason, verbatim, when the phase is `failed`. */
  error?: string;
}

/**
 * ONE picture to push into the store, whatever it came from (docs/17 row 45).
 *
 * The two entry points — a file from this device and an image from the local
 * library — differ ONLY in how the bytes are read and in the metadata that
 * rides along; everything after this interface is the SAME code, so there is
 * one encoder, one object model and one index update (rule 4).
 */
export interface UploadSource {
  /** The owner-facing label of the progress row. */
  label: string;
  /**
   * The bytes to encode, produced LAZILY: a read that fails is that picture's
   * failure and never aborts the batch.
   */
  blob: () => Blob | Promise<Blob>;
  /**
   * What the object header must carry. For a device file this is the file name
   * and the tags selected at upload time; for a library image it is the row's
   * OWN prompt, model, source, tags and creation time, so a store listing shows
   * what the gallery showed (the owner's "complete with tags and everything").
   */
  metadata: {
    prompt: string;
    model: string;
    source: ImageSource;
    tags: readonly string[];
    createdAt: Date;
  };
}

/**
 * The failure text of ONE picture. A `429` keeps its `Retry-After` instead of
 * being retried silently: this seam never retries (a retried write could
 * double-upload), so the owner is told how long the service asked him to wait.
 */
function uploadFailureMessage(error: unknown): string {
  if (error instanceof ServerStoreError && error.retryAfterSeconds !== null) {
    return `${error.message} — the store asked to wait ${String(error.retryAfterSeconds)}s (Retry-After). Nothing was retried automatically.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * THE uploader: push `sources` into `slug`, each encoded to the store's WebP
 * format at the source's own pixel size, reporting every one of them.
 *
 * `onProgress` is called as each picture moves; the returned array matches the
 * input order. ONE picture failing never aborts the others — the owner gets one
 * honest row per picture (rule 2), and the successful uploads are real.
 *
 * THE SOURCE IDENTITY is computed HERE, once per picture, from the ORIGINAL
 * bytes before the store re-encode (docs/17 row 45), so BOTH entry points record
 * it: the object header and the folder index carry `sourceSha256`, the one hash
 * that can recognise a local picture again after WebP q90 replaced its bytes.
 *
 * The whole batch shares ONE index read and ONE sequence counter, advanced in
 * memory as each PUT lands, so a later picture in the batch cannot reuse a
 * sequence.
 */
export async function uploadSources(
  connection: StoreConnection,
  slug: string,
  sources: readonly UploadSource[],
  onProgress: (progress: UploadProgress) => void,
  quality: StoreQuality = DEFAULT_STORE_QUALITY,
): Promise<UploadProgress[]> {
  const target = connection.target;
  const directory = await readDirectory(target);
  const listing = directory.folders.find((folder) => folder.record.slug === slug);
  if (listing === undefined) {
    throw new Error(
      `There is no folder "${slug}" in store "${target.store}" to upload into. Create it first.`,
    );
  }
  const { index } = await ensureIndex(target, listing, directory.byName);
  const results: UploadProgress[] = [];

  for (const [position, source] of sources.entries()) {
    const key = `${String(position)}:${source.label}`;
    onProgress({ key, label: source.label, phase: 'reading' });
    try {
      const blob = await source.blob();
      const mimeType = blob.type === '' ? 'application/octet-stream' : blob.type;
      if (!mimeType.startsWith('image/')) {
        throw new Error(
          `Not an image: "${mimeType}". The store holds pictures, so a non-image is refused rather than stored unlabelled.`,
        );
      }
      /*
       * THE SOURCE IDENTITY (docs/17 row 45): the sha256 of the ORIGINAL bytes,
       * computed HERE in the ONE uploader so BOTH entry points record it. The
       * stored payload is WebP q90, so its own hash can never identify a local
       * picture again; this is the hash that survives the re-encode, and it is
       * the same `sha256(bytes)` the export manifest carries (`src/lib/sha256.ts`,
       * the ONE hashing seam).
       */
      const sourceBytes = new Uint8Array(await blob.arrayBuffer());
      if (sourceBytes.length === 0) throw new Error('The picture is empty.');
      const sourceSha256 = await sha256Hex(sourceBytes);
      // Encode to the store format WITHOUT resizing: the pixels and the size
      // are the source's, only the encoding is compressed. A type the browser
      // substituted is refused inside `encodeStoreImage` (rule 1).
      const encoded = await encodeStoreImage(new Blob([sourceBytes], { type: mimeType }), quality);
      onProgress({ key, label: source.label, phase: 'uploading' });
      const uploaded = await uploadImage(
        target,
        {
          slug,
          bytes: encoded.bytes,
          mimeType: encoded.mimeType,
          width: encoded.width,
          height: encoded.height,
          quality: encoded.qualityPercent,
          /*
           * The metadata is CARRIED, not invented (docs/17 row 45): a library
           * push puts the row's own prompt, model, source, tags and creation
           * time into the object header, so the store shows what the gallery
           * showed. `favorite` is deliberately NOT carried — a shared store has
           * no per-user favourite, and the header schema has no field for one.
           */
          prompt: source.metadata.prompt,
          model: source.metadata.model,
          source: source.metadata.source,
          tags: source.metadata.tags,
          sourceSha256,
          id: crypto.randomUUID(),
          createdAt: source.metadata.createdAt,
        },
        index,
        directory.entries.map((entry) => entry.name),
      );
      // The index we hold in memory must advance too, or the next picture in
      // this batch would target the same sequence.
      index.nextSeq = uploaded.seq + 1;
      index.images.push({
        id: uploaded.id,
        name: uploaded.name,
        sha256: uploaded.sha256,
        size: uploaded.size,
        mimeType: encoded.mimeType,
        tags: [...source.metadata.tags],
        createdAt: source.metadata.createdAt.toISOString(),
        sourceSha256: uploaded.sourceSha256,
      });
      const done: UploadProgress = { key, label: source.label, phase: 'done', name: uploaded.name };
      onProgress(done);
      results.push(done);
    } catch (error: unknown) {
      const failed: UploadProgress = {
        key,
        label: source.label,
        phase: 'failed',
        error: uploadFailureMessage(error),
      };
      onProgress(failed);
      results.push(failed);
    }
  }
  return results;
}

/**
 * The DEVICE-FILE entry point: `Upload images…` in the folder dialog.
 *
 * Each file keeps the behaviour it always had — the file NAME is the stored
 * prompt, the model is the honest "uploaded file" label, the source is
 * `uploaded`, and the tags are the ones selected in the dialog. It is now a thin
 * adapter over the ONE uploader above, so this path and a library push cannot
 * drift apart.
 */
export async function uploadFiles(
  connection: StoreConnection,
  slug: string,
  files: readonly File[],
  tags: readonly string[],
  onProgress: (progress: UploadProgress) => void,
  quality: StoreQuality = DEFAULT_STORE_QUALITY,
): Promise<UploadProgress[]> {
  const createdAt = new Date();
  return uploadSources(
    connection,
    slug,
    files.map((file) => ({
      label: file.name,
      blob: () => file,
      metadata: {
        // The file name is what the owner will recognise in the folder; it is
        // stored as DATA (a prompt field), never parsed.
        prompt: file.name,
        model: UPLOADED_IMAGE_MODEL,
        source: 'uploaded',
        tags,
        createdAt,
      },
    })),
    onProgress,
    quality,
  );
}

/**
 * The LOCAL-LIBRARY entry point (docs/17 row 45): push stored gallery rows into
 * a store folder through the SAME uploader.
 *
 * What crosses over is the row's own metadata — prompt, model, source, tags and
 * creation time — and the row's OWN pixels, re-encoded to the store format at
 * their original size. The `favorite` flag is DROPPED: it is a per-device view
 * preference, and a shared store has no such concept to write (the object
 * header schema has no field for it either).
 */
export async function uploadStoredImages(
  connection: StoreConnection,
  slug: string,
  images: readonly StoredImage[],
  onProgress: (progress: UploadProgress) => void,
  quality: StoreQuality = DEFAULT_STORE_QUALITY,
): Promise<UploadProgress[]> {
  return uploadSources(
    connection,
    slug,
    images.map((image) => ({
      label: image.prompt.trim() === '' ? image.id : image.prompt,
      blob: () => imageBlob(image),
      metadata: {
        prompt: image.prompt,
        model: image.model,
        source: image.source,
        tags: image.tags,
        createdAt: new Date(image.createdAt),
      },
    })),
    onProgress,
    quality,
  );
}

/**
 * One image selected for download. The listing's `sha256` is the ONLY fact the
 * fetch needs beyond the name: the picture's own MIME type and size come from
 * its object header (docs/17 row 42), so a caller cannot pass a wrong one.
 *
 * Its file name is derived from the OBJECT NAME, which is stable and unique —
 * two uploads of `photo.jpg` into one folder are two different objects and must
 * not collide on disk.
 */
export interface DownloadTarget {
  name: string;
  sha256: string;
  /**
   * The picture's MIME type from the folder INDEX — used ONLY to suggest a file
   * name before the fetch. What is actually written is typed from the object's
   * own header, which is the authority.
   */
  mimeType: string;
}

/** What a download produced, for the caller's confirmation. */
export interface DownloadResult {
  fileName: string;
  fileCount: number;
}

/**
 * The SAVE REQUEST for a selection, built BEFORE any fetch.
 *
 * `saveFile` opens the file picker FIRST and only then calls `buildBytes`, and
 * it has to: the picker needs the click's transient activation, and fetching
 * every selected image can easily outlive that window. So the request is built
 * from the selection alone (the file name is derived locally), and the bytes
 * are fetched inside `buildBytes`.
 */
export function storeDownloadRequest(
  connection: StoreConnection,
  selections: readonly DownloadTarget[],
  now = new Date(),
): SaveRequest {
  const single = selections.length === 1 ? selections[0] : undefined;
  // The MIME type of a single-image save comes from the OBJECT's own header,
  // which is only known after the fetch; the SUGGESTED name is therefore built
  // without an extension guess, and `collectDownloads` reports the real type
  // for the write itself. A multi-selection is a ZIP, which is known up front.
  const fileName =
    single === undefined
      ? timestampedArchiveName('imager-store', now)
      : `${sanitizeFileName(single.name, 'image')}.${extensionFor(single.mimeType)}`;
  return {
    fileName,
    mimeType: single === undefined ? ARCHIVE_MIME_TYPE : single.mimeType,
    buildBytes: () => collectDownloads(connection, selections).then((archive) => archive.bytes),
  };
}

/**
 * Save a selection through the ONE save seam: the picker is opened inside the
 * click (the request is built synchronously), the bytes are fetched after a
 * destination exists, and a cancel is SILENT — `saveFile` reports it as an
 * outcome, not an error (docs/17 row 25).
 */
export async function saveStoreSelection(
  connection: StoreConnection,
  selections: readonly DownloadTarget[],
): Promise<SaveOutcome> {
  const request = storeDownloadRequest(connection, selections);
  const outcome = await saveFile(request);
  if (outcome.status === 'saved') {
    toastSuccess(
      `Saved ${request.fileName}`,
      selections.length > 1
        ? `${String(selections.length)} images, byte-identical to what the store served.`
        : undefined,
    );
  }
  return outcome;
}

/**
 * Fetch the selected images (verifying each against the listing's hash) and
 * return the bytes to save.
 *
 * ONE image comes back as itself; MORE than one comes back as ONE zip whose
 * entries are byte-identical to what the store served. `buildBytes` is the
 * save seam's contract, so the picker is opened before the fetch when the
 * browser has one (the click's transient activation is what makes the picker
 * work at all).
 */
export async function collectDownloads(
  connection: StoreConnection,
  selections: readonly DownloadTarget[],
): Promise<{ fileName: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }> {
  if (selections.length === 0) throw new Error('Nothing is selected to download.');
  const fetched: { name: string; bytes: Uint8Array<ArrayBuffer>; mimeType: string }[] = [];
  for (const selection of selections) {
    const original = await fetchOriginal(connection.target, selection.name, {
      sha256: selection.sha256,
    });
    /*
     * TWO independent checks, because a download is the one place a corrupt
     * picture would leave the app silently:
     *  1. the cache seam compared the SERVICE's `x-serverstore-sha256` with the
     *     listing's hash for the whole object;
     *  2. here the PICTURE inside it is hashed and compared with the hash its
     *     own header records — so a truncated or swapped payload is caught even
     *     if the object as a whole was the one the listing described.
     */
    if (original.payloadSha256 !== null) {
      const digest = await sha256Hex(original.bytes);
      if (digest !== original.payloadSha256) {
        throw new Error(
          `Refusing to save ${selection.name}: the picture inside hashes to ${digest} but its own header records ${original.payloadSha256}. The object is corrupt.`,
        );
      }
    }
    fetched.push({ name: selection.name, bytes: original.bytes, mimeType: original.mimeType });
  }

  if (fetched.length === 1) {
    const only = fetched[0];
    if (only === undefined) throw new Error('Nothing is selected to download.');
    const extension = extensionFor(only.mimeType);
    return {
      fileName: `${sanitizeFileName(only.name, 'image')}.${extension}`,
      mimeType: only.mimeType,
      bytes: only.bytes,
    };
  }

  const files = fetched.map((entry, position) => {
    const extension = extensionFor(entry.mimeType);
    const stem = sanitizeFileName(entry.name, 'image');
    return { name: `${String(position + 1).padStart(3, '0')}-${stem}.${extension}`, bytes: entry.bytes };
  });
  const archive = buildFilesArchive(files, timestampedArchiveName('imager-store', new Date()));
  return { fileName: archive.fileName, mimeType: archive.mimeType, bytes: archive.bytes };
}
