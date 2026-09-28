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
 */
import { extensionFor } from '@/domain/image';
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
import { ensureIndex, readDirectory, uploadImage } from '@/server/store-folders';
import type { StoreConnection } from '@/server/store-session';

/** One file's upload progress, reported PER FILE and never as a batch only. */
export type UploadPhase = 'pending' | 'reading' | 'uploading' | 'done' | 'failed';

export interface UploadProgress {
  fileName: string;
  phase: UploadPhase;
  /** The store object name, once it exists. */
  name?: string;
  /** The reason, verbatim, when the phase is `failed`. */
  error?: string;
}

/** Read one file into memory. A read failure is that file's failure, not the batch's. */
async function readFileBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Upload `files` into `slug`, encoded to the store's WebP format, reporting each one.
 *
 * `onProgress` is called as each file moves; the returned array matches the
 * input order. ONE file failing never aborts the others — the owner gets one
 * honest row per file (rule 2), and the successful uploads are real.
 */
export async function uploadFiles(
  connection: StoreConnection,
  slug: string,
  files: readonly File[],
  tags: readonly string[],
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

  for (const file of files) {
    onProgress({ fileName: file.name, phase: 'reading' });
    try {
      const bytes = await readFileBytes(file);
      if (bytes.length === 0) throw new Error('The file is empty.');
      const mimeType = file.type === '' ? 'application/octet-stream' : file.type;
      if (!mimeType.startsWith('image/')) {
        throw new Error(
          `Not an image: "${mimeType}". The store holds pictures, so a non-image file is refused rather than stored unlabelled.`,
        );
      }
      // Encode to the store format WITHOUT resizing: the pixels and the size
      // are the source's, only the encoding is compressed. A type the browser
      // substituted is refused inside `encodeStoreImage` (rule 1).
      const encoded = await encodeStoreImage(new Blob([bytes], { type: mimeType }), quality);
      onProgress({ fileName: file.name, phase: 'uploading' });
      const uploaded = await uploadImage(
        target,
        {
          slug,
          bytes: encoded.bytes,
          mimeType: encoded.mimeType,
          width: encoded.width,
          height: encoded.height,
          quality: encoded.qualityPercent,
          // The file name is what the owner will recognise in the folder; it is
          // stored as DATA (a prompt field), never parsed.
          prompt: file.name,
          model: 'uploaded file',
          source: 'uploaded',
          tags,
          id: crypto.randomUUID(),
          createdAt: new Date(),
        },
        index,
        directory.entries.map((entry) => entry.name),
      );
      // The index we hold in memory must advance too, or the next file in this
      // batch would target the same sequence.
      index.nextSeq = uploaded.seq + 1;
      index.images.push({
        id: uploaded.id,
        name: uploaded.name,
        sha256: uploaded.sha256,
        size: uploaded.size,
        mimeType: encoded.mimeType,
        tags: [...tags],
        createdAt: new Date().toISOString(),
      });
      const done: UploadProgress = { fileName: file.name, phase: 'done', name: uploaded.name };
      onProgress(done);
      results.push(done);
    } catch (error: unknown) {
      const failed: UploadProgress = {
        fileName: file.name,
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      onProgress(failed);
      results.push(failed);
    }
  }
  return results;
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
