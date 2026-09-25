import { getConversation, saveChatTurn } from '@/db/chatRepo';
import { buildGeneratedImages, getImage } from '@/db/imageRepo';
import { conversationTitle, type ChatMessage, type Conversation } from '@/domain/chat';
import { imageBlob, type Run } from '@/domain/image';
import {
  decodeImageBitmap,
  prepareReference,
  type ImageDecoder,
} from '@/features/refine/reference';
import { chatCompletion, type ChatTurnMessage } from '@/llm/chat';
import { errorMessage, toError } from '@/lib/errors';

export interface ChatTurnInput {
  apiKey: string;
  /** The refinement model: `settings.refineChatModel`. There is NO fallback. */
  model: string;
  /** The open conversation, or null to start a new one. */
  conversationId: string | null;
  text: string;
  signal?: AbortSignal | undefined;
}

export interface ChatTurnResult {
  /** The conversation AS STORED, including the failed assistant turn. */
  conversation: Conversation;
  run: Run;
  /** Non-null when the turn failed; the same message is stored AND returned. */
  error: Error | null;
}

/** Every stored image a turn sent back to the model, in conversation order. */
function sentImageIds(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap((message) => message.imageIds);
}

/**
 * The conversation as the model sees it: every prior user text and every prior
 * generated image, oldest first. A message with neither text nor images (a
 * failed turn) is skipped — there is nothing to send — while the failed turn
 * itself stays visible and stored in the conversation.
 *
 * Each image is re-encoded through the EXISTING reference prep
 * (`src/features/refine/reference.ts`), so the ≤`REFERENCE_MAX_EDGE_PX` cap,
 * the aspect preservation and the decode-failure behaviour are the same code
 * the Images API refinement uses. A stored image that is gone (deleted from the
 * gallery) is a LOUD failure, never a silently dropped reference.
 */
async function historyFor(
  conversation: Conversation,
  decode: ImageDecoder,
): Promise<ChatTurnMessage[]> {
  const history: ChatTurnMessage[] = [];
  for (const message of conversation.messages) {
    if (message.text.trim() === '' && message.imageIds.length === 0) continue;
    const dataUrls: string[] = [];
    for (const imageId of message.imageIds) {
      const stored = await getImage(imageId);
      if (stored === undefined) {
        throw new Error(
          `A generated image of this conversation is no longer in the gallery (${imageId}) — it cannot be sent back to the model`,
        );
      }
      dataUrls.push((await prepareReference(imageBlob(stored), decode)).dataUrl);
    }
    history.push({
      role: message.role,
      text: message.text,
      ...(dataUrls.length === 0 ? {} : { imageDataUrls: dataUrls }),
    });
  }
  return history;
}

/**
 * ONE chat turn → exactly one run row plus the conversation's new messages.
 *
 * The whole conversation is replayed on every turn (that is the feature: "now
 * add rain" needs what came before, including the images), and every generated
 * image is stored as a normal `StoredImage` in the gallery with its prompt,
 * model and run provenance — never as base64 inside the conversation.
 *
 * A failed turn is RECORDED (a failed run row plus an assistant message
 * carrying the error) and returned as `error` rather than thrown: the caller
 * needs the conversation identity the failure just created — a new conversation
 * exists only after this call. The error is still loud: it is stored on the
 * turn, returned to the caller, toasted by the UI, and rendered in the
 * conversation. A failure of the STORE itself does throw.
 */
export async function runChatTurn(
  input: ChatTurnInput,
  decode: ImageDecoder = decodeImageBitmap,
): Promise<ChatTurnResult> {
  const existing =
    input.conversationId === null ? null : ((await getConversation(input.conversationId)) ?? null);
  if (input.conversationId !== null && existing === null) {
    throw new Error(`Conversation ${input.conversationId} no longer exists`);
  }
  const now = Date.now();
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    text: input.text,
    imageIds: [],
    runId: '',
    model: '',
    costUsd: null,
    error: null,
    createdAt: now,
  };
  const base: Conversation = existing ?? {
    id: crypto.randomUUID(),
    title: conversationTitle(input.text),
    model: input.model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const withUser: Conversation = {
    ...base,
    model: input.model,
    updatedAt: now,
    messages: [...base.messages, userMessage],
  };
  const runId = crypto.randomUUID();
  // What this turn sent back: every image of the PRIOR turns (the new user
  // message has none).
  const sentIds = sentImageIds(base.messages);

  try {
    const result = await chatCompletion({
      apiKey: input.apiKey,
      model: input.model,
      messages: await historyFor(withUser, decode),
      signal: input.signal,
    });
    const images = await buildGeneratedImages({
      images: result.images,
      prompt: input.text,
      model: result.model,
      runId,
      createdAt: now,
    });
    const run: Run = {
      id: runId,
      kind: 'chat-refine',
      prompt: input.text,
      model: result.model,
      inputImageIds: sentIds,
      requestedCount: 1,
      receivedCount: images.length,
      filteredCount: 0,
      costUsd: result.costUsd,
      createdAt: now,
      error: null,
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: result.text,
      imageIds: images.map((image) => image.id),
      runId,
      model: result.model,
      costUsd: result.costUsd,
      error: null,
      createdAt: now + 1,
    };
    const conversation: Conversation = {
      ...withUser,
      model: result.model,
      updatedAt: Date.now(),
      messages: [...withUser.messages, assistantMessage],
    };
    await saveChatTurn(conversation, run, images);
    return { conversation, run, error: null };
  } catch (error) {
    const message = errorMessage(error);
    const run: Run = {
      id: runId,
      kind: 'chat-refine',
      prompt: input.text,
      model: input.model,
      inputImageIds: sentIds,
      requestedCount: 1,
      receivedCount: 0,
      filteredCount: 0,
      costUsd: null,
      createdAt: now,
      error: message,
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      imageIds: [],
      runId,
      model: input.model,
      costUsd: null,
      error: message,
      createdAt: Date.now(),
    };
    const conversation: Conversation = {
      ...withUser,
      updatedAt: Date.now(),
      messages: [...withUser.messages, assistantMessage],
    };
    await saveChatTurn(conversation, run, []);
    return { conversation, run, error: toError(error) };
  }
}
