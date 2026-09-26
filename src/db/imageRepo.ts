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
 * An ADDITIVE field carries the meaning its ABSENCE already had, so the
 * defaults below are the reading the app had before the field existed, never a
 * mask for a broken row: an image with no recorded provenance is one the app
 * generated, a run with no recorded kind is a plain generation, and an image
 * with no `favorite` was written before favourites existed — it is NOT a
 * favourite (docs/17 row 32). Any other missing field still throws.
 */
function parseImage(row: unknown): StoredImage {
  const record = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  const parsed = storedImageSchema.safeParse({ source: 'generated', favorite: false, ...record });
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

/**
 * Favourites first, newest-first within each group (docs/17 row 32). THIS is
 * the whole ordering seam: the index read already yields newest-first, and the
 * split into two groups is a STABLE partition of that list, so each group keeps
 * its own newest-first order. No component re-sorts — a second implementation
 * of "favourites on top" is the defect `tests/architecture/one-ordering.test.ts`
 * refuses.
 */
export async function listImages(): Promise<StoredImage[]> {
  const images = (await db.images.orderBy('createdAt').reverse().toArray()).map(parseImage);
  return [...images.filter((image) => image.favorite), ...images.filter((image) => !image.favorite)];
}

/**
 * Flip ONE image's `favorite` flag, writing ONLY that field's value: the row is
 * read, validated through `parseImage` (which supplies the pre-field default for
 * a legacy row) and written back with the flag changed. The BYTES are never
 * re-encoded — they go back exactly as they were read, and the pin in
 * `tests/db/imageRepo.test.ts` compares the whole raw row before/after.
 *
 * WHY NOT `db.images.update(id, { favorite })`, the obvious partial update: it
 * is NOT safe for a row that carries a `Uint8Array`. Dexie's `Table.update` →
 * `Collection.modify` runs the record through Dexie's own `deepClone`, which
 * passes a typed array through ONLY when it recognises its constructor by
 * identity in Dexie's captured global. A `Uint8Array` from another realm — the
 * jsdom test environment, and any future case where the row crosses one — is
 * cloned into a look-alike object with no typed-array internal slot, so the
 * stored `bytes` stops being a `Uint8Array` and the NEXT read throws "Stored
 * image is corrupt" (MEASURED: the stored value's tag became `[object Object]`,
 * constructor `Object`; `.gate-logs/favourites/dexie-update-probe*.log`). The
 * read-validate-put below goes through IndexedDB's own structured clone, which
 * is realm-correct — and it is what makes "only the flag changed" provable.
 *
 * ONE transaction, so a delete racing this toggle cannot resurrect the row. A
 * missing row is a LOUD failure rather than a silent no-op (rule 1).
 */
export async function setImageFavorite(id: string, favorite: boolean): Promise<void> {
  await db.transaction('rw', db.images, async () => {
    const row = await db.images.get(id);
    if (row === undefined) throw new Error(`No stored image with id "${id}" to update.`);
    await db.images.put({ ...parseImage(row), favorite });
  });
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

export interface GeneratedImageInput {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/**
 * The rows for a model response's images — ONE place that turns decoded model
 * output into `StoredImage` records, used by BOTH generation paths (the Images
 * API `runGeneration` and the chat turn `runChatTurn`). Dimensions are decoded
 * per image (a decode failure THROWS, rule 1); `createdAt` increments per index
 * so the gallery's `createdAt` order matches the response order.
 */
export async function buildGeneratedImages(input: {
  images: readonly GeneratedImageInput[];
  prompt: string;
  model: string;
  runId: string;
  createdAt: number;
}): Promise<StoredImage[]> {
  const stored: StoredImage[] = [];
  for (const [index, image] of input.images.entries()) {
    const size = await imageSize(new Blob([image.bytes], { type: image.mimeType }));
    stored.push(
      storedImageSchema.parse({
        id: crypto.randomUUID(),
        bytes: image.bytes,
        mimeType: image.mimeType,
        ...size,
        prompt: input.prompt,
        model: input.model,
        source: 'generated',
        createdAt: input.createdAt + index,
        runId: input.runId,
        // A brand-new image is nobody's favourite until the owner says so.
        favorite: false,
      }),
    );
  }
  return stored;
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
    favorite: false,
  };
  await db.images.put(storedImageSchema.parse(image));
  return image;
}
