import { z } from 'zod';

/**
 * A conversation and its ordered messages (slice 4, the chat-refinement path).
 *
 * An assistant turn OWNS its generated images by id: the bytes live in the
 * normal `images` gallery table (`StoredImage`, one `runId` per turn), never
 * duplicated as base64 inside the conversation. A conversation is therefore
 * small, survives a reload, and reopens with the same provenance any other
 * image has.
 */
export const CHAT_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

export const chatMessageSchema = z.strictObject({
  id: z.string().min(1),
  role: z.enum(CHAT_MESSAGE_ROLES),
  /** The user's free text, or the model's answer. NEVER parsed (rule 5). */
  text: z.string(),
  /** `StoredImage` ids this turn produced; only assistant turns have them. */
  imageIds: z.array(z.string().min(1)),
  /** The run this turn recorded; `''` on a user turn, which makes no run. */
  runId: z.string(),
  /** The model that answered this turn; `''` on a user turn. */
  model: z.string(),
  /** `usage.cost` for this turn; null when the API reported none. */
  costUsd: z.number().nullable(),
  /** The failure message of a failed turn, null on a user/successful turn. */
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const conversationSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  /** The model of the LATEST turn (each message records its own too). */
  model: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(chatMessageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** The conversation-list budget for a derived title, in characters. */
export const CONVERSATION_TITLE_MAX_CHARS = 60;

/**
 * The title of a conversation is the FIRST USER MESSAGE, first line, trimmed,
 * cut to `CONVERSATION_TITLE_MAX_CHARS` with an ellipsis. It is a display
 * truncation, not an interpretation: no pattern is run over the free text
 * (AGENTS rule 5) — the string is only split on newlines and sliced. The text
 * is never empty here: the composer refuses an empty draft, so the first user
 * message always carries content.
 */
export function conversationTitle(firstUserText: string): string {
  const firstLine = firstUserText.trim().split('\n')[0]?.trim() ?? '';
  return firstLine.length > CONVERSATION_TITLE_MAX_CHARS
    ? `${firstLine.slice(0, CONVERSATION_TITLE_MAX_CHARS)}…`
    : firstLine;
}

/**
 * What the conversation has cost so far: the sum of every ASSISTANT turn's
 * reported `usage.cost`. A turn the API reported no cost for is counted in
 * `missingTurns` and is NOT summed as 0 (that would understate spend); with no
 * reported cost at all the total is null, never 0.
 */
export function conversationCost(conversation: Conversation): {
  totalUsd: number | null;
  missingTurns: number;
} {
  let total = 0;
  let reported = 0;
  let missingTurns = 0;
  for (const message of conversation.messages) {
    if (message.role !== 'assistant') continue;
    if (message.costUsd === null) missingTurns += 1;
    else {
      total += message.costUsd;
      reported += 1;
    }
  }
  return { totalUsd: reported === 0 ? null : total, missingTurns };
}
