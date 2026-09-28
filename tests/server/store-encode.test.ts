import { expect, it } from 'vitest';

import {
  STORE_FALLBACK_MIME_TYPE,
  STORE_IMAGE_MIME_TYPE,
  THUMBNAIL_MAX_EDGE_PX,
  encodeStoreImage,
  encodeThumbnail,
  qualityPercent,
  type StoreQuality,
} from '@/server/store-encode';

/**
 * docs/17 row 42 — THE STORE FORMAT, and the two ways it can lie.
 *
 * The owner's final decision: WebP at quality 90, WITHOUT resizing. The dangers
 * this file pins are (a) a browser silently substituting a different format
 * (the AVIF trap: `toBlob('image/avif')` answers PNG where it cannot encode it)
 * and (b) a resize creeping into the stored bytes.
 */

/** jsdom has no canvas at all, so the encoder the seam calls is double here —
 * but with the REAL method name, signature and async-ness (ledger rows 14/15:
 * a double that invents a different shape certifies code the real object
 * refuses). */
class FakeCanvas {
  static readonly calls: { width: number; height: number; type: string; quality: number }[] = [];
  /** What the fake encoder answers with; `null` = the type it was asked for. */
  static substituteWith: string | null = null;
  /** True = reject for any lossy type (an encoder that does not exist). */
  static failLossy = false;

  readonly width: number;
  readonly height: number;
  private readonly context: { drawImage: () => void };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.context = { drawImage: () => undefined };
  }

  getContext(): { drawImage: () => void } {
    return this.context;
  }

  convertToBlob(options: { type: string; quality?: number }): Promise<Blob> {
    FakeCanvas.calls.push({
      width: this.width,
      height: this.height,
      type: options.type,
      quality: options.quality ?? -1,
    });
    if (FakeCanvas.failLossy && options.type !== STORE_FALLBACK_MIME_TYPE) {
      return Promise.reject(new TypeError(`no encoder for ${options.type}`));
    }
    const type = FakeCanvas.substituteWith ?? options.type;
    // The bytes encode the drawn size, so a test can prove WHICH bitmap was
    // encoded and at what size.
    return Promise.resolve(new Blob([new Uint8Array([this.width % 256, this.height % 256, 7])], { type }));
  }
}

function stubCanvas(): void {
  FakeCanvas.calls.length = 0;
  FakeCanvas.substituteWith = null;
  FakeCanvas.failLossy = false;
  globalThis.OffscreenCanvas = FakeCanvas as unknown as typeof OffscreenCanvas;
}

/** A decoder double matching the real contract: a bitmap with a size, closable. */
function decoderFor(width: number, height: number): (blob: Blob) => Promise<ImageBitmap> {
  return () =>
    Promise.resolve({
      width,
      height,
      close: () => undefined,
    } as unknown as ImageBitmap);
}

const SOURCE = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

it('the store payload is WebP at the chosen quality, at the SOURCE pixel size', async () => {
  stubCanvas();
  const encoded = await encodeStoreImage(SOURCE, 'High', decoderFor(2000, 1000));
  expect(encoded.mimeType).toBe(STORE_IMAGE_MIME_TYPE);
  expect(encoded.qualityPercent).toBe(qualityPercent('High'));
  expect(encoded.qualityPercent).toBe(90);
  // NO RESIZE: the canvas the encoder drew to is the source's own size.
  expect(FakeCanvas.calls).toEqual([
    { width: 2000, height: 1000, type: STORE_IMAGE_MIME_TYPE, quality: 0.9 },
  ]);
  expect(encoded.width).toBe(2000);
  expect(encoded.height).toBe(1000);
});

it('each quality step is a real, distinct encoder parameter', async () => {
  stubCanvas();
  const steps: StoreQuality[] = ['High', 'Balanced', 'Small'];
  const percents: number[] = [];
  for (const step of steps) {
    const encoded = await encodeStoreImage(SOURCE, step, decoderFor(800, 600));
    percents.push(encoded.qualityPercent);
  }
  expect(percents).toEqual([90, 80, 65]);
  expect(FakeCanvas.calls.map((call) => call.quality)).toEqual([0.9, 0.8, 0.65]);
});

it('a SUBSTITUTED format is a LOUD failure — the AVIF trap, generalised', async () => {
  stubCanvas();
  // The browser answers PNG for a requested WebP. Storing that under the
  // `.webp` assumption is the silent lie rule 1 forbids.
  FakeCanvas.substituteWith = STORE_FALLBACK_MIME_TYPE;
  await expect(encodeStoreImage(SOURCE, 'High', decoderFor(100, 100))).rejects.toThrow(
    /cannot encode image\/webp.*answered image\/png/s,
  );
});

it('a genuinely UNAVAILABLE lossy encoder falls back to PNG and SAYS so', async () => {
  stubCanvas();
  FakeCanvas.failLossy = true;
  const encoded = await encodeStoreImage(SOURCE, 'High', decoderFor(120, 80));
  // The fallback is visible in the metadata — never passed off as WebP.
  expect(encoded.mimeType).toBe(STORE_FALLBACK_MIME_TYPE);
  expect(FakeCanvas.calls.map((call) => call.type)).toEqual([
    STORE_IMAGE_MIME_TYPE,
    STORE_FALLBACK_MIME_TYPE,
  ]);
});

it('a THUMBNAIL is the only thing that is resized, and never above the source', async () => {
  stubCanvas();
  const big = await encodeThumbnail(SOURCE, decoderFor(2000, 1000));
  expect(big).toMatchObject({ width: THUMBNAIL_MAX_EDGE_PX, height: THUMBNAIL_MAX_EDGE_PX / 2 });
  expect(FakeCanvas.calls).toEqual([
    { width: 512, height: 256, type: STORE_IMAGE_MIME_TYPE, quality: 0.8 },
  ]);
  // A source smaller than the cap is NOT upscaled.
  FakeCanvas.calls.length = 0;
  const small = await encodeThumbnail(SOURCE, decoderFor(300, 200));
  expect(small).toMatchObject({ width: 300, height: 200 });
});

it('a non-image is refused by name, and an empty encode is an error', async () => {
  stubCanvas();
  await expect(
    encodeStoreImage(new Blob([new Uint8Array([1])], { type: 'text/plain' }), 'High', decoderFor(1, 1)),
  ).rejects.toThrow(/Not an image/);
});
