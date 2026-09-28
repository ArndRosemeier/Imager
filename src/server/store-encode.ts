/**
 * THE image-encoding seam for ServerStore objects (docs/17 row 42).
 *
 * What the store holds, decided by the owner in his own words: *"this is not
 * for art professionals, its for people who make images with AI and want to
 * share and store them. So a compression thats unnoticable for normal people is
 * plenty good."* — i.e. **WebP at quality 90, WITHOUT resizing**: the full pixel
 * resolution the generator (or the upload) produced, only the ENCODING
 * compressed.
 *
 * WHY WebP (recorded so it is not re-litigated):
 *  * HEIC — impossible. Chrome and Firefox have never supported it on any
 *    version and no browser can ENCODE it (HEVC licensing; caniuse
 *    "HEIF/HEIC image format"). Only Safari 17+ can read it.
 *  * JPEG — dominated. Google's own WebP compression study measures WebP
 *    25–34% smaller than JPEG at equal SSIM across four datasets
 *    (developers.google.com/speed/webp/docs/webp_study).
 *  * AVIF — better ratio, a TRAP for v1. `canvas.toBlob('image/avif')` /
 *    `convertToBlob({type:'image/avif'})` **silently returns a PNG** where the
 *    browser cannot encode AVIF — exactly the silent substitution rule 1
 *    forbids. Left OUT of v1 (not implemented); recorded as the future option
 *    together with that trap.
 *  * PNG — kept as the lossless fallback when a lossy encode is unavailable.
 *
 * THE ENCODER IS VERIFIED, NOT TRUSTED: `downscaleToType` returns the blob's
 * ACTUAL `type`, and `encodeStoreImage` refuses anything that is not the
 * requested type. This is the generalised AVIF trap and it is pinned.
 *
 * This module owns the FORMAT POLICY (the output type, the quality steps, the
 * PNG fallback, the thumbnail cap); the canvas encode-and-verify primitive is
 * the app's ONE encoder in `src/features/refine/reference.ts`, shared with the
 * refinement reference path.
 */
import {
  EncoderUnavailableError,
  bytesToDataUrl,
  decodeImageBitmap,
  encodeCanvasAs,
  scaleTarget,
  type EncodedBytes,
  type ImageDecoder,
} from '@/features/refine/reference';

/** The long edge of a browser thumbnail, in px — the thumbnail path's ONLY
 * downscale (the stored image itself is never resized). */
export const THUMBNAIL_MAX_EDGE_PX = 512;

/** The thumbnail's quality: small files, and a grid cell is not a print. */
export const THUMBNAIL_QUALITY = 0.8;

/** The requested store format. WebP q90; see the header for why. */
export const STORE_IMAGE_MIME_TYPE = 'image/webp';

/** The lossless fallback when a runtime cannot encode WebP at all. */
export const STORE_FALLBACK_MIME_TYPE = 'image/png';

/**
 * The user-visible quality steps (owner's ask: adjustable without a code
 * change, default High). `High` is the default; the numbers are the encoder's
 * own quality parameter (0–1), which is what a WebP encoder takes.
 */
export const STORE_QUALITIES = ['High', 'Balanced', 'Small'] as const;
export type StoreQuality = (typeof STORE_QUALITIES)[number];

/** The quality parameter behind each step, for the encoder AND the metadata. */
export const STORE_QUALITY_VALUES: Record<StoreQuality, number> = {
  High: 0.9,
  Balanced: 0.8,
  Small: 0.65,
};

export const DEFAULT_STORE_QUALITY: StoreQuality = 'High';

/** The quality number recorded in an object's header (an integer percent). */
export function qualityPercent(quality: StoreQuality): number {
  return Math.round(STORE_QUALITY_VALUES[quality] * 100);
}

/** What one encoded store payload is. */
export interface StoreImageBytes {
  bytes: Uint8Array<ArrayBuffer>;
  /** The ACTUAL MIME type the encoder produced (verified, never assumed). */
  mimeType: string;
  /** The pixels' own size — equal to the source's, because nothing is resized. */
  width: number;
  height: number;
  /** The quality step this payload was encoded at, for the object header. */
  quality: StoreQuality;
  /** The recorded quality percent (an integer, so a reader sees the number). */
  qualityPercent: number;
}

/**
 * Encode at the bitmap's OWN size (the store path: compressed, never resized).
 */
export async function encodeBitmapAs(
  bitmap: ImageBitmap,
  type: string,
  quality: number,
): Promise<EncodedBytes> {
  return encodeCanvasAs(bitmap, { width: bitmap.width, height: bitmap.height }, type, quality);
}

/**
 * Encode with the store's FORMAT POLICY: WebP, or the lossless PNG fallback
 * when — and ONLY when — the browser has no WebP encoder at all (it REJECTED
 * the type). A SUBSTITUTED type is never caught here: it propagates as the loud
 * failure it is.
 */
export async function encodeStoreFormat(
  bitmap: ImageBitmap,
  quality: number,
): Promise<EncodedBytes> {
  try {
    return await encodeBitmapAs(bitmap, STORE_IMAGE_MIME_TYPE, quality);
  } catch (error: unknown) {
    if (!(error instanceof EncoderUnavailableError)) throw error;
    return encodeBitmapAs(bitmap, STORE_FALLBACK_MIME_TYPE, 1);
  }
}

/**
 * A source image Blob → the bytes the store holds: WebP at the chosen quality,
 * at the source's OWN pixel size (never resized).
 *
 * `decode` is injectable so a test can drive the encode branch without a real
 * image codec; production always passes `decodeImageBitmap`.
 */
export async function encodeStoreImage(
  blob: Blob,
  quality: StoreQuality,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<StoreImageBytes> {
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Not an image: "${blob.type === '' ? 'unknown type' : blob.type}"`);
  }
  const bitmap = await decode(blob);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error('Image decoded to an empty size');
    const encoded = await encodeStoreFormat(bitmap, STORE_QUALITY_VALUES[quality]);
    return {
      bytes: encoded.bytes,
      mimeType: encoded.mimeType,
      width: bitmap.width,
      height: bitmap.height,
      quality,
      qualityPercent: qualityPercent(quality),
    };
  } finally {
    bitmap.close();
  }
}

/**
 * The THUMBNAIL payload: the ONLY place a store image is resized, and only for
 * the browser's grid. Derived from the FULL image the store holds, at
 * `THUMBNAIL_MAX_EDGE_PX`, encoded WebP (PNG fallback) — never written back
 * anywhere.
 */
export async function encodeThumbnail(
  blob: Blob,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string; width: number; height: number }> {
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Not an image: "${blob.type === '' ? 'unknown type' : blob.type}"`);
  }
  const bitmap = await decode(blob);
  try {
    const target = scaleTarget(bitmap.width, bitmap.height, THUMBNAIL_MAX_EDGE_PX);
    let encoded: EncodedBytes;
    try {
      encoded = await encodeCanvasAs(bitmap, target, STORE_IMAGE_MIME_TYPE, THUMBNAIL_QUALITY);
    } catch (error: unknown) {
      if (!(error instanceof EncoderUnavailableError)) throw error;
      encoded = await encodeCanvasAs(bitmap, target, STORE_FALLBACK_MIME_TYPE, 1);
    }
    return {
      bytes: encoded.bytes,
      mimeType: encoded.mimeType,
      width: target.width,
      height: target.height,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * The definition of a store object's payload, for the UI copy. It names the
 * quality ACTUALLY chosen: the quality switch lets the owner pick Balanced or
 * Small, so the sentence beside it must not keep claiming 90 (an on-screen
 * number that contradicts what is written is a small lie the uploader can
 * avoid). Defaults to the owner's `High` (90).
 */
export function storeEncodingDescription(
  quality: StoreQuality = DEFAULT_STORE_QUALITY,
): string {
  return `WebP at quality ${String(qualityPercent(quality))}, at the image's own pixel size — compressed, never resized.`;
}

/** A `data:` URL for an encoded payload, for callers that need one. */
export function storeBytesToDataUrl(image: StoreImageBytes): string {
  return bytesToDataUrl(image.bytes, image.mimeType);
}
