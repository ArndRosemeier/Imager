import { z } from 'zod';

/**
 * The Sounds and Voice tabs' data (docs/17 row 60): ONE kind of row, an audio
 * CLIP rendered from one text by the speech path (`src/llm/speech.ts`). A sound
 * and a spoken line are the same thing to store, play, tag, download and back
 * up — only the tab they belong to and the form they were made with differ, so
 * they share one table, one repo and one tab component, told apart by `kind`.
 */
export const CLIP_KINDS = ['sound', 'voice'] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];

/** What the owner asked for. Absent options were NOT sent: the model decides. */
export const clipRequestSchema = z.strictObject({
  model: z.string().min(1),
  /** The words to speak (voice), or the description of the sound (sound). */
  text: z.string().min(1),
  /** The voice picked from the model's list; null = the model's default. */
  voice: z.string().nullable(),
  /** Delivery guidance ("whispered, slow"); null = none sent. */
  instructions: z.string().nullable(),
});
export type ClipRequest = z.infer<typeof clipRequestSchema>;

const bytesSchema = z.custom<Uint8Array<ArrayBuffer>>(
  (v) => Object.prototype.toString.call(v) === '[object Uint8Array]',
);

/** One rendered clip. */
export const storedClipSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(CLIP_KINDS),
  bytes: bytesSchema,
  /** The SNIFFED type (`src/lib/audioFormat.ts`), never an assumed one. */
  mimeType: z.string().min(1),
  request: clipRequestSchema,
  /** OpenRouter's generation id, when it sent one (the speech API reports no cost). */
  generationId: z.string().nullable(),
  createdAt: z.number(),
  /** The owner's tags — the SAME vocabulary and rules as images and videos. */
  tags: z.array(z.string()).default([]),
});
export type StoredClip = z.infer<typeof storedClipSchema>;
