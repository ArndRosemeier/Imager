import { z } from 'zod';

/**
 * Stored images and runs (shape ported from Campaigner `src/domain/image.ts`).
 * Bytes are `Uint8Array`, not Blob: structured clone (IndexedDB and
 * fake-indexeddb) round-trips typed arrays reliably, Blobs do not.
 */
export const IMAGE_SOURCES = ['generated', 'uploaded'] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];

export const storedImageSchema = z.strictObject({
  id: z.string().min(1),
  // Tag check, not instanceof: a structured-cloned array may come from another realm.
  bytes: z.custom<Uint8Array<ArrayBuffer>>(
    (v) => Object.prototype.toString.call(v) === '[object Uint8Array]',
  ),
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  prompt: z.string(),
  model: z.string().min(1),
  /** Provenance: produced by a run, or uploaded from disk (slice 3). */
  source: z.enum(IMAGE_SOURCES),
  createdAt: z.number(),
  /**
   * The run that produced this image; EMPTY for an upload, which no run
   * produced. A sentinel run id would be a fabricated row (rule 1), and the
   * type cannot be optional without making every stored row ambiguous.
   */
  runId: z.string(),
});
export type StoredImage = z.infer<typeof storedImageSchema>;

/**
 * The model value recorded for an uploaded file. There is no generating model
 * behind an upload, and a stored image requires a non-empty `model`; this is
 * that honest placeholder, never a model the app picked.
 */
export const UPLOADED_IMAGE_MODEL = 'uploaded file';

/**
 * Which request path produced a run. `generate` = text-to-image, `refine` =
 * the Images API's `input_references` path, `chat-refine` = one turn of the
 * multi-turn chat-completion path with image output (`src/llm/chat.ts`). The
 * third value exists because the paths are different endpoints with different
 * request shapes, and the run log must name which one spent the money.
 */
export const RUN_KINDS = ['generate', 'refine', 'chat-refine'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const runSchema = z.strictObject({
  id: z.string().min(1),
  /** Which seam path produced this run. */
  kind: z.enum(RUN_KINDS),
  prompt: z.string(),
  model: z.string().min(1),
  /**
   * `StoredImage` ids sent to the model as references: `input_references` on
   * the Images API path, sent-back assistant images on the chat path.
   */
  inputImageIds: z.array(z.string().min(1)),
  requestedCount: z.number().int().positive(),
  receivedCount: z.number().int().nonnegative(),
  filteredCount: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
  createdAt: z.number(),
  error: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

export function imageBlob(image: StoredImage): Blob {
  return new Blob([image.bytes], { type: image.mimeType });
}

/** File extension for a stored MIME type (jpeg → jpg). */
export function extensionFor(mimeType: string): string {
  const sub = mimeType.split('/')[1] ?? '';
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  if (sub === '') throw new Error(`Unknown image type "${mimeType}"`);
  return sub;
}
