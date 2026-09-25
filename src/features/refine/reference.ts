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
 */
import { base64FromBytes } from '@/lib/base64';

/** The long edge of a reference image sent to the model, in px. PINNED. */
export const REFERENCE_MAX_EDGE_PX = 1024;

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

/**
 * The size a decoded `width`×`height` image is sent at: the source size when
 * it already fits, else both edges scaled by the same factor so the LONG edge
 * is exactly `REFERENCE_MAX_EDGE_PX` (aspect ratio preserved, never 0).
 */
export function referenceTarget(
  width: number,
  height: number,
): { width: number; height: number; downscaled: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= REFERENCE_MAX_EDGE_PX) return { width, height, downscaled: false };
  const scale = REFERENCE_MAX_EDGE_PX / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    downscaled: true,
  };
}

/** The browser decode seam: a bitmap, or a THROWN decode error. */
export type ImageDecoder = (blob: Blob) => Promise<ImageBitmap>;

export const decodeImageBitmap: ImageDecoder = (blob) => createImageBitmap(blob);

/** `Uint8Array` + MIME → `data:` URL, without a FileReader. */
export function bytesToDataUrl(bytes: Uint8Array<ArrayBuffer>, mimeType: string): string {
  return `data:${mimeType};base64,${base64FromBytes(bytes)}`;
}

/**
 * Re-encodes a decoded bitmap at `target` size. Prefers `OffscreenCanvas`
 * (no DOM document needed) and falls back to a detached `<canvas>`; a runtime
 * with neither is a loud error, never a pass-through of an oversized image.
 */
function encodeScaled(
  bitmap: ImageBitmap,
  target: { width: number; height: number },
  mimeType: string,
): string {
  const draw = (context: CanvasRenderingContext2D): string => {
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    return context.canvas.toDataURL(mimeType);
  };
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Could not get a 2d context to downscale the reference');
    return draw(context as unknown as CanvasRenderingContext2D);
  }
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Could not get a 2d context to downscale the reference');
  return draw(context);
}

/**
 * THE entry point: any image Blob → the reference payload for one model
 * request. Decodes once, downscales only when the long edge exceeds the
 * pinned cap, and reports the dimensions actually encoded.
 *
 * `decode` is injectable so a test can drive the resize branch without a real
 * image codec; production always passes `decodeImageBitmap`.
 */
export async function prepareReference(
  blob: Blob,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<ReferenceImage> {
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Not an image: "${blob.type === '' ? 'unknown type' : blob.type}"`);
  }
  const bitmap = await decode(blob);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new Error('Image decoded to an empty size');
    }
    const target = referenceTarget(bitmap.width, bitmap.height);
    if (!target.downscaled) {
      return {
        dataUrl: bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type),
        width: bitmap.width,
        height: bitmap.height,
        downscaled: false,
      };
    }
    return {
      dataUrl: encodeScaled(bitmap, target, blob.type),
      width: target.width,
      height: target.height,
      downscaled: true,
    };
  } finally {
    bitmap.close();
  }
}
