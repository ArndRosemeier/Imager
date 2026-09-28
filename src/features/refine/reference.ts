/**
 * THE refinement reference-prep seam (slice 3): a stored image OR an uploaded
 * file → ONE `data:` URL ready to be sent as an `input_references` entry.
 *
 * WHY the cap: a reference image is billed and limited PER MODEL (OpenRouter
 * publishes `input_references` counts per model — `src/llm/imageModels.ts`),
 * so a 4000px phone photo is pure waste. The LONG edge is capped at
 * `REFERENCE_MAX_EDGE_PX` (1024) with the aspect ratio preserved; an image
 * that already fits is sent untouched (never upscaled).
 *
 * Every failure here THROWS — a decode failure is a loud error, and the run
 * that asked for the reference records a failed row (rule 1).
 *
 * THIS MODULE ALSO OWNS THE APP'S ONE CANVAS DOWNSCALE (`encodeScaledBytes`,
 * `downscaleToBytes`). The ServerStore thumbnail cache derives its small
 * display copies HERE rather than growing a second resize implementation
 * (docs/17 row 42): what differs between a model reference and a browser
 * thumbnail is the CAP and the OUTPUT ENCODING, never the scaling maths.
 */
import { base64FromBytes } from '@/lib/base64';

/** The long edge of a reference image sent to the model, in px. PINNED. */
export const REFERENCE_MAX_EDGE_PX = 1024;

/** The reference encoder's quality: a reference is a working image, not a
 * deliverable, so it is the store's `Balanced` step (docs/17 row 42). */
export const REFERENCE_QUALITY = 0.8;

/** `accept` for the upload input: images only, as the schema expects. */
export const IMAGE_ACCEPT = 'image/*';

export interface ReferenceImage {
  /** `data:<mime>;base64,<bytes>` — exactly what goes into `image_url.url`. */
  dataUrl: string;
  /** The dimensions of the ENCODED payload (the downscaled ones when resized). */
  width: number;
  height: number;
  /** True when the source was larger than the cap and was re-encoded smaller. */
  downscaled: boolean;
}

/** The size a `width`×`height` image is scaled to for a `maxEdge` cap: the
 * source size when it already fits, else both edges scaled by the same factor
 * so the LONG edge is exactly `maxEdge` (aspect preserved, never 0). */
export function scaleTarget(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; downscaled: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height, downscaled: false };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    downscaled: true,
  };
}

/** The size a decoded image is sent at as a refinement reference. */
export function referenceTarget(
  width: number,
  height: number,
): { width: number; height: number; downscaled: boolean } {
  return scaleTarget(width, height, REFERENCE_MAX_EDGE_PX);
}

/**
 * The encoder REJECTED the requested type rather than substituting one. The two
 * demand opposite responses — an unavailable lossy encoder may fall back to
 * lossless, a substitution is a LOUD failure — so they are different errors.
 */
export class EncoderUnavailableError extends Error {
  constructor(type: string, cause: unknown) {
    // The underlying reason is kept IN THE MESSAGE: the reference path has no
    // fallback, so its user-visible error is this one, and "the encoder refused
    // the bitmap" must not be replaced by a generic sentence.
    super(
      `This browser cannot encode ${type}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'EncoderUnavailableError';
  }
}

/** What one encoder call produced, with the type it ACTUALLY produced. */
export interface EncodedBytes {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/**
 * Draw `source` at `size` onto a fresh canvas and encode it as `type`.
 *
 * THE ONE canvas encoder in the app (docs/17 row 42): the refinement reference
 * path, the ServerStore object encoder and the thumbnail path all come through
 * here, so "how Imager turns pixels into bytes" has one definition. A rejected
 * type becomes `EncoderUnavailableError` (a fallback is legitimate); a blob
 * whose `type` is not the requested one is a plain loud `Error` — the AVIF trap,
 * where the browser silently answers PNG for a requested AVIF.
 */
export async function encodeCanvasAs(
  source: CanvasImageSource,
  size: { width: number; height: number },
  type: string,
  quality: number,
): Promise<EncodedBytes> {
  if (typeof OffscreenCanvas !== 'function') {
    throw new Error(
      'This browser has no OffscreenCanvas, so an image cannot be re-encoded. Imager requires the OffscreenCanvas API (Baseline 2023).',
    );
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Could not get a 2d context to encode an image');
  context.drawImage(source, 0, 0, size.width, size.height);
  let blob: Blob;
  try {
    blob = await canvas.convertToBlob({ type, quality });
  } catch (error: unknown) {
    throw new EncoderUnavailableError(type, error);
  }
  if (blob.size === 0) throw new Error('The image encoder produced an empty file.');
  if (blob.type !== type) {
    throw new Error(
      `The browser cannot encode ${type}: the encoder answered ${blob.type === '' ? 'no type at all' : blob.type} instead. Nothing was stored or sent — a silently substituted format would look fine until someone opened the image.`,
    );
  }
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
}

/** The browser decode seam: a bitmap, or a THROWN decode error. */
export type ImageDecoder = (blob: Blob) => Promise<ImageBitmap>;

export const decodeImageBitmap: ImageDecoder = (blob) => createImageBitmap(blob);

/** `Uint8Array` + MIME → `data:` URL, without a FileReader. */
export function bytesToDataUrl(bytes: Uint8Array<ArrayBuffer>, mimeType: string): string {
  return `data:${mimeType};base64,${base64FromBytes(bytes)}`;
}

/** One re-encoded payload: the bytes, their MIME type and their dimensions. */
export interface EncodedImage {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  width: number;
  height: number;
  /** True when the source was larger than the cap and was re-encoded smaller. */
  downscaled: boolean;
}

/**
 * `OffscreenCanvas` → `Blob`.
 *
 * The OffscreenCanvas contract has NO `toDataURL` — that is an
 * `HTMLCanvasElement` method, and calling it on an OffscreenCanvas is a
 * TypeError in every real browser (the live defect this seam carried, docs/17
 * row 15). An OffscreenCanvas encodes ASYNCHRONOUSLY through `convertToBlob`,
 * which resolves with a `Blob` and rejects on a zero-sized bitmap. An empty
 * blob is a loud error, never a pass-through of an oversized image (rule 1).
 *
 * THIS IS THE ONLY CANVAS PATH (docs/17 row 42). The detached-`<canvas>` +
 * `toDataURL` fallback is gone: `createImageBitmap` and `OffscreenCanvas` are
 * the same support class (both Baseline 2023), so the fallback could only ever
 * run in a browser where this app's decode seam had already failed, and it
 * cost a SECOND canvas implementation, a SECOND base64 assembly and a second
 * network call site this app does not need. A runtime without `OffscreenCanvas`
 * is a loud error naming it.
 *
 * THE TYPE CHECK IN `encodeCanvasAs` IS LOAD-BEARING, and it is the reason this
 * module — not its callers — owns the encoder: a browser asked for a format it
 * cannot encode may answer with a DIFFERENT one (measured for `image/avif`,
 * which comes back as PNG), and a caller that trusted the request would store a
 * mislabelled file (docs/17 row 42, the generalised AVIF trap).
 */
/**
 * Re-encode a decoded bitmap at `target` size and return the ENCODED BYTES.
 * Prefers `OffscreenCanvas` (no DOM document needed) and falls back to a
 * detached `<canvas>`; a runtime with neither is a loud error, never a
 * pass-through of an oversized image.
 */
export async function encodeScaledBytes(
  bitmap: ImageBitmap,
  target: { width: number; height: number },
  mimeType: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> {
  // A reference is sent at the SOURCE's own quality policy: the encoder is
  // shared, the quality knob is the caller's (the store passes its own).
  return encodeCanvasAs(bitmap, target, mimeType, REFERENCE_QUALITY);
}

/**
 * A `Blob` → a smaller payload with its LONG edge capped at `maxEdge`.
 *
 * The rule the ServerStore thumbnail cache and the reference seam share:
 * an image that already fits comes back BYTE FOR BYTE (never re-encoded, never
 * upscaled — re-encoding a picture to make it "the same size" only loses
 * quality); a larger one is re-encoded at the cap with the aspect preserved.
 * `decode` is injectable so a test can drive the resize branch without a real
 * image codec; production always passes `decodeImageBitmap`.
 */
export async function downscaleToBytes(
  blob: Blob,
  maxEdge: number,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<EncodedImage> {
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Not an image: "${blob.type === '' ? 'unknown type' : blob.type}"`);
  }
  const bitmap = await decode(blob);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new Error('Image decoded to an empty size');
    }
    const target = scaleTarget(bitmap.width, bitmap.height, maxEdge);
    if (!target.downscaled) {
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: blob.type,
        width: bitmap.width,
        height: bitmap.height,
        downscaled: false,
      };
    }
    const encoded = await encodeScaledBytes(bitmap, target, blob.type);
    return { ...encoded, width: target.width, height: target.height, downscaled: true };
  } finally {
    bitmap.close();
  }
}

/**
 * THE entry point: any image Blob → the reference payload for one model
 * request. Decodes once, downscales only when the long edge exceeds the
 * pinned cap, and reports the dimensions actually encoded.
 */
export async function prepareReference(
  blob: Blob,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<ReferenceImage> {
  const image = await downscaleToBytes(blob, REFERENCE_MAX_EDGE_PX, decode);
  return {
    dataUrl: bytesToDataUrl(image.bytes, image.mimeType),
    width: image.width,
    height: image.height,
    downscaled: image.downscaled,
  };
}
