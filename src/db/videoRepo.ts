import { db } from '@/db/db';
import {
  storedVideoSchema,
  videoJobSchema,
  type StoredVideo,
  type VideoJob,
} from '@/domain/video';

/**
 * The video repo (docs/17 row 56). zod at the read boundary: a corrupt row
 * THROWS (rule 1/3), it is never served as a shorter list.
 */
function parseVideo(row: unknown): StoredVideo {
  const parsed = storedVideoSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored video is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

function parseJob(row: unknown): VideoJob {
  const parsed = videoJobSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored video job is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

/** Every finished video, oldest first (the backup's order). */
export async function listVideos(): Promise<StoredVideo[]> {
  return (await db.videos.orderBy('createdAt').toArray()).map(parseVideo);
}

/** Every job still running or failed, oldest first. */
export async function listVideoJobs(): Promise<VideoJob[]> {
  return (await db.videoJobs.orderBy('createdAt').toArray()).map(parseJob);
}

/** Store (or update) a job. */
export async function putVideoJob(job: VideoJob): Promise<void> {
  await db.videoJobs.put(videoJobSchema.parse(job));
}

/**
 * A finished job becomes a video in ONE transaction: there is never a moment
 * where the video is stored twice, or where the job is gone and the video is not.
 */
export async function completeVideoJob(video: StoredVideo): Promise<void> {
  await db.transaction('rw', db.videos, db.videoJobs, async () => {
    await db.videos.put(storedVideoSchema.parse(video));
    await db.videoJobs.delete(video.id);
  });
}

/** Dismiss a (failed) job. */
export async function deleteVideoJob(id: string): Promise<void> {
  await db.videoJobs.delete(id);
}

export async function deleteVideo(id: string): Promise<void> {
  await db.videos.delete(id);
}
