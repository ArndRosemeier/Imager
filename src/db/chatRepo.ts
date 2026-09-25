import { db } from '@/db/db';
import { saveRun } from '@/db/imageRepo';
import { conversationSchema, type Conversation } from '@/domain/chat';
import type { Run, StoredImage } from '@/domain/image';

/**
 * The conversation repo. zod at the read boundary: a corrupt row THROWS
 * (rule 1/3) — a conversation with a broken message list is never served as a
 * shorter one.
 */
function parseConversation(row: unknown): Conversation {
  const parsed = conversationSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored conversation is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

/** Newest first (by the last turn). */
export async function listConversations(): Promise<Conversation[]> {
  return (await db.conversations.orderBy('updatedAt').reverse().toArray()).map(parseConversation);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const row = await db.conversations.get(id);
  return row === undefined ? undefined : parseConversation(row);
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await db.conversations.put(conversationSchema.parse(conversation));
}

/**
 * ONE chat turn lands atomically: the conversation (carrying the new user and
 * assistant messages) plus the run row and the generated images. `saveRun` is
 * reused — the ONE run-recording seam, so a chat run is recorded exactly like
 * any other run — and the conversation joins the SAME transaction, so a
 * conversation can never end up pointing at images whose write failed.
 */
export async function saveChatTurn(
  conversation: Conversation,
  run: Run,
  images: readonly StoredImage[],
): Promise<void> {
  await db.transaction('rw', db.conversations, db.runs, db.images, async () => {
    await saveRun(run, images);
    await db.conversations.put(conversationSchema.parse(conversation));
  });
}
