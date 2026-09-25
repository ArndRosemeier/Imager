import { db } from '@/db/db';
import { runSchema, storedImageSchema, type Run, type StoredImage } from '@/domain/image';

/** zod at the read boundary: a corrupt row THROWS (rule 1/3). */
function parseImage(row: unknown): StoredImage {
  const parsed = storedImageSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored image is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

function parseRun(row: unknown): Run {
  const parsed = runSchema.safeParse(row);
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

export async function deleteImage(id: string): Promise<void> {
  await db.images.delete(id);
}
