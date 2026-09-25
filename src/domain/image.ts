import { z } from 'zod';

/**
 * Stored images and runs (shape ported from Campaigner `src/domain/image.ts`).
 * Bytes are `Uint8Array`, not Blob: structured clone (IndexedDB and
 * fake-indexeddb) round-trips typed arrays reliably, Blobs do not.
 */
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
  createdAt: z.number(),
  runId: z.string().min(1),
});
export type StoredImage = z.infer<typeof storedImageSchema>;

export const runSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string(),
  model: z.string().min(1),
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
