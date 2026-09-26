import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getConversation, listConversations, saveChatTurn, saveConversation } from '@/db/chatRepo';
import { db } from '@/db/db';
import {
  conversationCost,
  conversationTitle,
  type ChatMessage,
  type Conversation,
} from '@/domain/chat';
import type { Run, StoredImage } from '@/domain/image';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    text: 'hello',
    imageIds: [],
    runId: '',
    model: '',
    costUsd: null,
    error: null,
    createdAt: 1,
    ...overrides,
  };
}

function conversation(id: string, updatedAt: number, messages: ChatMessage[] = []): Conversation {
  return { id, title: 'a title', model: 'google/gemini-2.5-flash-image', createdAt: 1, updatedAt, messages };
}

function storedImage(id: string, runId: string): StoredImage {
  return {
    id,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: 'make it rain',
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 2,
    runId,
    favorite: false,
    tags: [],
  };
}

function chatRun(id: string): Run {
  return {
    id,
    kind: 'chat-refine',
    prompt: 'make it rain',
    model: 'google/gemini-2.5-flash-image',
    inputImageIds: [],
    requestedCount: 1,
    receivedCount: 1,
    filteredCount: 0,
    costUsd: 0.01,
    createdAt: 2,
    error: null,
  };
}

beforeEach(async () => {
  await Promise.all([db.images.clear(), db.runs.clear(), db.conversations.clear()]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('a chat turn lands as conversation + run + images in ONE transaction', async () => {
  const withTurn = conversation('c1', 5, [
    message({ role: 'user', text: 'make it rain' }),
    message({
      role: 'assistant',
      text: 'Rain added.',
      imageIds: ['img-1'],
      runId: 'run-1',
      model: 'google/gemini-2.5-flash-image',
      costUsd: 0.01,
    }),
  ]);
  await saveChatTurn(withTurn, chatRun('run-1'), [storedImage('img-1', 'run-1')]);

  await expect(getConversation('c1')).resolves.toEqual(withTurn);
  await expect(db.runs.count()).resolves.toBe(1);
  await expect(db.images.count()).resolves.toBe(1);
  const run = await db.runs.get('run-1');
  expect(run?.kind).toBe('chat-refine');
  const image = await db.images.get('img-1');
  expect(image?.runId).toBe('run-1');
  expect(image?.prompt).toBe('make it rain');
});

it('conversations list newest first and a corrupt row throws', async () => {
  await saveConversation(conversation('old', 1));
  await saveConversation(conversation('new', 2));
  await expect(listConversations()).resolves.toEqual([
    expect.objectContaining({ id: 'new' }),
    expect.objectContaining({ id: 'old' }),
  ]);

  await db.conversations.put({ id: 'broken', title: 'x' } as never);
  await expect(getConversation('broken')).rejects.toThrow(/corrupt/);
});

it('the conversation total sums only reported assistant costs, never as 0', () => {
  const messages = [
    message({ role: 'user', text: 'q1' }),
    message({ role: 'assistant', text: 'a1', costUsd: 0.25 }),
    message({ role: 'assistant', text: '', error: 'boom', costUsd: null }),
    message({ role: 'assistant', text: 'a2', costUsd: 0.5 }),
  ];
  expect(conversationCost(conversation('c', 1, messages))).toEqual({
    totalUsd: 0.75,
    missingTurns: 1,
  });
  expect(conversationCost(conversation('c', 1, [message({ role: 'assistant', costUsd: null })]))).toEqual(
    { totalUsd: null, missingTurns: 1 },
  );
});

it('the title is the first user message, first line, cut to the budget (no pattern)', () => {
  expect(conversationTitle('  make the sky darker\nand add rain  ')).toBe('make the sky darker');
  const long = 'x'.repeat(200);
  const title = conversationTitle(long);
  expect(title).toHaveLength(61);
  expect(title.endsWith('…')).toBe(true);
});
