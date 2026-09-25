import { getImage, saveRun } from '@/db/imageRepo';
import { imageBlob, type Run, type RunKind, type StoredImage } from '@/domain/image';
import {
  decodeImageBitmap,
  prepareReference,
  type ImageDecoder,
  type ReferenceImage,
} from '@/features/refine/reference';
import { generateImages, type ReferenceInput } from '@/llm/images';
import { errorMessage } from '@/lib/errors';
import { imageSize } from '@/lib/imageSize';

export interface GenerationInput {
  apiKey: string;
  model: string;
  prompt: string;
  n: number;
  aspectRatio?: string | undefined;
  /**
   * Stored images to send as `input_references`. Empty → `kind: 'generate'`;
   * non-empty → `kind: 'refine'` and the ids are recorded on the run.
   */
  inputImageIds: readonly string[];
  signal?: AbortSignal | undefined;
}

/** Absent means "not stored" — the run records the loss and sends nothing. */
function presentImages(images: readonly (StoredImage | undefined)[]): StoredImage[] {
  return images.filter((image): image is StoredImage => image !== undefined);
}

/**
 * One generation OR refinement → exactly one run row. Success stores N images
 * with it; failure stores a FAILED run row (error message, `kind` and
 * `inputImageIds` kept) and zero images, then rethrows so the caller toasts
 * (rule 2). An abort also records the run.
 *
 * The refine path is NOT a second runner: it resolves the source ids to bytes
 * and calls the same `generateImages` seam with `inputReferences` — the ONE
 * place a request is made.
 */
export async function runGeneration(
  input: GenerationInput,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<Run> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const kind: RunKind = input.inputImageIds.length === 0 ? 'generate' : 'refine';
  const base = {
    id,
    kind,
    prompt: input.prompt,
    model: input.model,
    inputImageIds: [...input.inputImageIds],
    requestedCount: input.n,
    createdAt,
  };
  try {
    const references: ReferenceInput[] = [];
    if (kind === 'refine') {
      const sources = presentImages(
        await Promise.all(input.inputImageIds.map((sourceId) => getImage(sourceId))),
      );
      if (sources.length !== input.inputImageIds.length) {
        throw new Error(
          `Refinement source image is missing (${String(input.inputImageIds.length - sources.length)} of ${String(input.inputImageIds.length)})`,
        );
      }
      const prepared: ReferenceImage[] = [];
      for (const source of sources) {
        prepared.push(await prepareReference(imageBlob(source), decode));
      }
      references.push(...prepared.map((reference) => ({ dataUrl: reference.dataUrl })));
    }
    const result = await generateImages({
      apiKey: input.apiKey,
      model: input.model,
      prompt: input.prompt,
      n: input.n,
      aspectRatio: input.aspectRatio,
      inputReferences: references,
      signal: input.signal,
    });
    const images: StoredImage[] = [];
    for (const [i, img] of result.images.entries()) {
      const size = await imageSize(new Blob([img.bytes], { type: img.mimeType }));
      images.push({
        id: crypto.randomUUID(),
        ...img,
        ...size,
        prompt: input.prompt,
        model: input.model,
        source: 'generated',
        createdAt: createdAt + i,
        runId: id,
      });
    }
    const run: Run = {
      ...base,
      receivedCount: images.length,
      filteredCount: result.filteredCount,
      costUsd: result.costUsd,
      error: null,
    };
    await saveRun(run, images);
    return run;
  } catch (error) {
    await saveRun(
      { ...base, receivedCount: 0, filteredCount: 0, costUsd: null, error: errorMessage(error) },
      [],
    );
    throw error;
  }
}
