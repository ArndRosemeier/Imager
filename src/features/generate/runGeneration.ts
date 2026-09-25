import { saveRun } from '@/db/imageRepo';
import type { Run, StoredImage } from '@/domain/image';
import { generateImages } from '@/llm/images';
import { errorMessage } from '@/lib/errors';
import { imageSize } from '@/lib/imageSize';

export interface GenerationInput {
  apiKey: string;
  model: string;
  prompt: string;
  n: number;
  aspectRatio?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * One generation → exactly one run row. Success stores N images with it;
 * failure stores a FAILED run row (error message) and zero images, then
 * rethrows so the caller toasts (rule 2). An abort also records the run.
 */
export async function runGeneration(input: GenerationInput): Promise<Run> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const base = {
    id,
    prompt: input.prompt,
    model: input.model,
    requestedCount: input.n,
    createdAt,
  };
  try {
    const result = await generateImages(input);
    const images: StoredImage[] = [];
    for (const [i, img] of result.images.entries()) {
      const size = await imageSize(new Blob([img.bytes], { type: img.mimeType }));
      images.push({
        id: crypto.randomUUID(),
        ...img,
        ...size,
        prompt: input.prompt,
        model: input.model,
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
