import { getImage } from '@/db/imageRepo';
import { completeVideoJob, putVideoJob } from '@/db/videoRepo';
import { imageBlob } from '@/domain/image';
import type { VideoJob, VideoRequest } from '@/domain/video';
import { decodeImageBitmap, prepareReference, type ImageDecoder } from '@/features/refine/reference';
import { downloadVideo, pollVideo, submitVideo } from '@/llm/video';
import { errorMessage } from '@/lib/errors';

/**
 * The Videos tab's two steps (docs/17 row 56). `startVideo` submits a job and
 * STORES it at once — the money is spent from that moment, so the job must
 * outlive a tab switch or a reload. `checkVideoJob` polls a stored job once and
 * stores what it learned: still working, failed (with the reason), or finished
 * (downloaded and turned into a video in one transaction).
 */
export async function startVideo({
  apiKey,
  request,
  decode = decodeImageBitmap,
}: {
  apiKey: string;
  request: VideoRequest;
  decode?: ImageDecoder;
}): Promise<VideoJob> {
  const frameDataUrl = async (imageId: string | null, which: string): Promise<string | null> => {
    if (imageId === null) return null;
    const image = await getImage(imageId);
    if (image === undefined) {
      throw new Error(`The ${which} image is no longer in the gallery — pick another one.`);
    }
    // The SAME reference prep every other image upload uses (≤1024 px edge).
    return (await prepareReference(imageBlob(image), decode)).dataUrl;
  };
  const firstFrameDataUrl = await frameDataUrl(request.firstFrameImageId, 'start');
  const lastFrameDataUrl = await frameDataUrl(request.lastFrameImageId, 'end');
  const jobId = await submitVideo({
    apiKey,
    model: request.model,
    prompt: request.prompt,
    duration: request.duration,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    generateAudio: request.generateAudio,
    firstFrameDataUrl,
    lastFrameDataUrl,
  });
  const job: VideoJob = { id: jobId, request, status: 'pending', error: null, createdAt: Date.now() };
  try {
    await putVideoJob(job);
  } catch (error: unknown) {
    // The job is running and paid for; say which one, so it is not lost silently.
    throw new Error(
      `OpenRouter accepted the video job ${jobId}, but it could not be stored in this browser: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return job;
}

/** What one check of a job ended in. */
export type VideoCheckOutcome = 'active' | 'completed' | 'failed';

/**
 * Poll one job and store the result. ANY failure on the way (the poll, the
 * download, a format the app does not know) is stored on the job as a failure
 * with its reason — visible on its row, where "Check again" retries it — never
 * swallowed and never read as "still working".
 */
export async function checkVideoJob(apiKey: string, job: VideoJob): Promise<VideoCheckOutcome> {
  try {
    const state = await pollVideo(apiKey, job.id);
    if (state.kind === 'active') {
      if (state.status !== job.status) await putVideoJob({ ...job, status: state.status });
      return 'active';
    }
    if (state.kind === 'failed') {
      await putVideoJob({ ...job, status: 'failed', error: state.error });
      return 'failed';
    }
    const video = await downloadVideo(apiKey, job.id);
    await completeVideoJob({
      id: job.id,
      bytes: video.bytes,
      mimeType: video.mimeType,
      request: job.request,
      costUsd: state.costUsd,
      createdAt: Date.now(),
      // A new video is untagged until the owner tags it, like a new image.
      tags: [],
    });
    return 'completed';
  } catch (error: unknown) {
    await putVideoJob({ ...job, status: 'failed', error: errorMessage(error) });
    return 'failed';
  }
}
