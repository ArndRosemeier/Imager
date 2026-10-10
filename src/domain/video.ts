import { z } from 'zod';

/**
 * The Videos tab's data (docs/17 row 56).
 *
 * WHY TWO KINDS OF ROW. OpenRouter's video generation is ASYNCHRONOUS: a POST
 * starts a job, the job is polled until it completes (half a minute to several
 * minutes), and only then are the bytes downloaded. A job is therefore stored
 * the moment it is submitted (`VideoJob`) — the money is spent from that
 * moment, so closing the tab or switching away must never lose it — and it
 * becomes a `StoredVideo` (with bytes) in ONE transaction when its download
 * lands. A failed job stays visible with its error until the owner dismisses it.
 */

/** What the owner asked for. Absent options were NOT sent: the model decides. */
export const videoRequestSchema = z.strictObject({
  model: z.string().min(1),
  prompt: z.string(),
  /** Seconds; null = not sent (the model's own default). */
  duration: z.number().int().positive().nullable(),
  resolution: z.string().nullable(),
  aspectRatio: z.string().nullable(),
  /** null = not sent (the model cannot make audio, or it was not offered). */
  generateAudio: z.boolean().nullable(),
  /** The gallery image the video STARTS from; null = none. */
  firstFrameImageId: z.string().nullable(),
  /**
   * The gallery image the video ENDS on; null = none. `.default(null)` so a
   * request stored before end frames existed reads as "no end frame".
   */
  lastFrameImageId: z.string().nullable().default(null),
});
export type VideoRequest = z.infer<typeof videoRequestSchema>;

/** The states a job is stored in. A completed job is no longer a job. */
export const VIDEO_JOB_STATUSES = ['pending', 'in_progress', 'failed'] as const;
export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];

export const videoJobSchema = z.strictObject({
  /** OpenRouter's job id — the key every poll and the download use. */
  id: z.string().min(1),
  request: videoRequestSchema,
  status: z.enum(VIDEO_JOB_STATUSES),
  /** Why it failed (status `failed`); null otherwise. */
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type VideoJob = z.infer<typeof videoJobSchema>;

const bytesSchema = z.custom<Uint8Array<ArrayBuffer>>(
  (v) => Object.prototype.toString.call(v) === '[object Uint8Array]',
);

/** One generated video. Its id is the OpenRouter job id it came from. */
export const storedVideoSchema = z.strictObject({
  id: z.string().min(1),
  bytes: bytesSchema,
  /** The SNIFFED type (`src/lib/videoFormat.ts`), never an assumed one. */
  mimeType: z.string().min(1),
  request: videoRequestSchema,
  costUsd: z.number().nullable(),
  createdAt: z.number(),
  /**
   * The owner's tags — the SAME vocabulary and rules as image tags
   * (`src/domain/tags.ts`, docs/17 row 59). `.default([])`: a video stored
   * before tags existed reads as untagged.
   */
  tags: z.array(z.string()).default([]),
});
export type StoredVideo = z.infer<typeof storedVideoSchema>;

/** True while the server is still working on the job. */
export function isActiveJob(job: VideoJob): boolean {
  return job.status !== 'failed';
}
