import { db } from '@/db/db';
import {
  UPLOADED_IMAGE_MODEL,
  runSchema,
  storedImageSchema,
  type Run,
  type StoredImage,
} from '@/domain/image';
import { imageSize } from '@/lib/imageSize';

/**
 * zod at the read boundary: a corrupt row THROWS (rule 1/3).
 *
 * Slice 3 added two fields to shipped rows. Both carry the meaning their
 * absence already had — an image with no recorded provenance is one the app
 * generated, a run with no recorded kind is a plain generation — so the
 * defaults below are the same reading the app had before the fields existed,
 * never a mask for a broken row. Any other missing field still throws.
 */
function parseImage(row: unknown): StoredImage {
  const record = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  const parsed = storedImageSchema.safeParse({ source: 'generated', ...record });
  if (!parsed.success) throw new Error(`Stored image is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

function parseRun(row: unknown): Run {
  const record = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  const parsed = runSchema.safeParse({ kind: 'generate', inputImageIds: [], ...record });
  if (!parsed.success) throw new Error(`Stored run is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

/** One run row plus its images, atomically. */
export async function saveRun(run: Run, images: readonly StoredImage[]): Promise<void> {
  await db.transaction('rw', db.runs, db.images, async () => {
    await db.runs.put(runSchema.parse(run));
    await db.images.bulkPut(images.map((i) => storedImageSchema.parse(i)));
  });
}

/** Newest first. */
export async function listImages(): Promise<StoredImage[]> {
  return (await db.images.orderBy('createdAt').reverse().toArray()).map(parseImage);
}

export async function listRuns(): Promise<Run[]> {
  return (await db.runs.orderBy('createdAt').reverse().toArray()).map(parseRun);
}

export async function getRun(id: string): Promise<Run | undefined> {
  const row = await db.runs.get(id);
  return row === undefined ? undefined : parseRun(row);
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  const row = await db.images.get(id);
  return row === undefined ? undefined : parseImage(row);
}

export async function deleteImage(id: string): Promise<void> {
  await db.images.delete(id);
}

export interface UploadInput {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  fileName: string;
}

/**
 * Stores an uploaded file as a `StoredImage` in the SAME table as generated
 * images, so it appears in the gallery and can be reused as a refinement
 * source. `runId` is empty: `Run` names a GENERATION run and an upload made
 * none — writing a fabricated run row only to satisfy a notional foreign key
 * would be exactly the silent placeholder rule 1 forbids.
 *
 * The stored `prompt` is the file's name (free text shown in the gallery,
 * never parsed) and the stored size is the file's own — that is what the user
 * uploaded. The ≤1024px cap applies to what is SENT to a model and lives in
 * `src/features/refine/reference.ts`.
 */
export async function saveUploadedImage(
  input: UploadInput,
  createdAt = Date.now(),
): Promise<StoredImage> {
  const size = await imageSize(new Blob([input.bytes], { type: input.mimeType }));
  const image: StoredImage = {
    id: crypto.randomUUID(),
    bytes: input.bytes,
    mimeType: input.mimeType,
    ...size,
    prompt: input.fileName,
    model: UPLOADED_IMAGE_MODEL,
    source: 'uploaded',
    createdAt,
    runId: '',
  };
  await db.images.put(storedImageSchema.parse(image));
  return image;
}
