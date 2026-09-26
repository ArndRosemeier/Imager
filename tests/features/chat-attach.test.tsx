import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { Gallery } from '@/features/gallery/Gallery';
import { resetImageModelCache } from '@/llm/imageModels';
import { resetModelCache } from '@/llm/models';
import { jsonResponse } from '../helpers';

/**
 * docs/17 row 18: the full image view's "Chat with this image" and the
 * cross-tab request that carries it into the composer's EXISTING staged
 * attachment state (row 16).
 */
const modelsJson = readFileSync('tests/fixtures/models-trimmed.json', 'utf8');
const imagesModelsJson = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');
const CHAT_MODEL = 'google/gemini-2.5-flash-image';
const SEED_ID = 'gallery-seed-1';
const SEED_PROMPT = 'seeded for chat';
const DATA_URL = `data:image/png;base64,${btoa('generated-bytes')}`;
let posts: string[] = [];

function stubFetch(chatBody: () => Response): void {
  posts = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/models?output_modalities=all')) return Promise.resolve(new Response(modelsJson));
    if (url.endsWith('/images/models')) return Promise.resolve(new Response(imagesModelsJson));
    if (url.endsWith('/chat/completions')) {
      posts.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(chatBody());
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

/** 64×32 is UNDER the reference cap, so the send path needs no canvas codec. */
function decodeAt(width: number, height: number): () => Promise<ImageBitmap> {
  return () => Promise.resolve({ width, height, close: () => undefined } as unknown as ImageBitmap);
}

function chatAnswer(text: string): Response {
  return jsonResponse({
    model: CHAT_MODEL,
    choices: [
      { message: { role: 'assistant', content: text, images: [{ image_url: { url: DATA_URL } }] } },
    ],
    usage: { cost: 0.2 },
  });
}

/** A gallery row the lightbox can open; `runId: ''` means it has no run. */
async function seedImage(): Promise<void> {
  await db.images.put({
    id: SEED_ID,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 64,
    height: 32,
    prompt: SEED_PROMPT,
    model: 'openai/gpt-image-1',
    source: 'generated',
    createdAt: 1,
    runId: '',
  });
}

/** Thumbnail → lightbox → "Chat with this image". */
async function openChatFromGallery(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Open image: ${SEED_PROMPT}` }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Image details' })).getByRole('button', {
      name: 'Chat with this image',
    }),
  );
}

beforeEach(async () => {
  resetImageModelCache();
  resetModelCache();
  await Promise.all([db.settings.clear(), db.images.clear(), db.runs.clear(), db.conversations.clear()]);
  vi.stubGlobal('createImageBitmap', decodeAt(64, 32));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the lightbox offers the chat button only when onChat is provided', async () => {
  await seedImage();
  const user = userEvent.setup();
  const onChat = vi.fn();
  const first = render(<Gallery version={0} onChat={onChat} />);
  await user.click(await screen.findByRole('button', { name: `Open image: ${SEED_PROMPT}` }));
  const dialog = screen.getByRole('dialog', { name: 'Image details' });
  // The layout claim, as far as jsdom can honestly see it: the classes that
  // replaced the `max-h-[70vh]` box (the real pixel claim is measured in a
  // browser, ledger row 17).
  expect(dialog).toHaveClass('fixed', 'inset-0', 'flex', 'flex-col');
  expect(within(dialog).getByRole('img', { name: SEED_PROMPT })).toHaveClass(
    'max-h-full',
    'max-w-full',
    'object-contain',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Chat with this image' }));
  expect(onChat).toHaveBeenCalledWith(SEED_ID);
  // Like "Refine this", the lightbox closes on the click.
  expect(screen.queryByRole('dialog', { name: 'Image details' })).toBeNull();
  first.unmount();

  // Never an invented affordance: without the handler the button is absent.
  render(<Gallery version={0} />);
  await user.click(await screen.findByRole('button', { name: `Open image: ${SEED_PROMPT}` }));
  const bare = screen.getByRole('dialog', { name: 'Image details' });
  expect(within(bare).queryByRole('button', { name: 'Chat with this image' })).toBeNull();
  expect(within(bare).queryByRole('button', { name: 'Refine this' })).toBeNull();
});

it('one click lands on Chat with the gallery image staged — no re-upload, no chat request', async () => {
  await seedImage();
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  stubFetch(() => jsonResponse({}));
  render(<App />);
  const user = userEvent.setup();
  await openChatFromGallery(user);

  expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  const staged = await screen.findByRole('list', { name: 'Attached images' });
  expect(within(staged).getAllByRole('listitem')).toHaveLength(1);
  expect(within(staged).getByRole('img', { name: SEED_PROMPT })).toBeInTheDocument();
  // Staging is a Dexie READ of the existing row: no chat request, no new image.
  expect(posts).toEqual([]);
  await expect(db.images.count()).resolves.toBe(1);
  await expect(db.runs.count()).resolves.toBe(0);
  // The picture alone is a message, so Send is enabled with an empty draft.
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

it('a consumed request never re-attaches on a later remount, and re-picking the SAME image stages it again', async () => {
  await seedImage();
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  stubFetch(() => jsonResponse({}));
  render(<App />);
  const user = userEvent.setup();
  await openChatFromGallery(user);
  expect(await screen.findByRole('list', { name: 'Attached images' })).toBeInTheDocument();

  // Leave and re-enter the Chat tab: `ChatArea` remounts. If the request had
  // NOT been consumed, the remount would stage it again — a stale attach by
  // surprise. The Dexie flush gives that wrongful effect time to happen.
  await user.click(screen.getByRole('tab', { name: 'Generate' }));
  await user.click(screen.getByRole('tab', { name: 'Chat' }));
  await waitFor(async () => {
    await db.images.count();
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull();
  });

  // The SAME image again is a NEW request (its nonce differs), so it stages.
  await user.click(screen.getByRole('tab', { name: 'Generate' }));
  await openChatFromGallery(user);
  expect(await screen.findByRole('list', { name: 'Attached images' })).toBeInTheDocument();
});

it('a gallery-staged image rides the user message exactly like a file attachment', async () => {
  await seedImage();
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  stubFetch(() => chatAnswer('Started from your gallery.'));
  render(<App />);
  const user = userEvent.setup();
  await openChatFromGallery(user);
  await screen.findByRole('list', { name: 'Attached images' });
  await user.type(await screen.findByLabelText('Message'), 'make it darker');
  await user.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByText('Started from your gallery.')).toBeInTheDocument();
  const sent = JSON.parse(posts[0] ?? '') as { messages: { role: string; content: unknown }[] };
  const parts = sent.messages[0]?.content as { type: string; image_url?: { url: string } }[];
  // The row-16 mechanism, unchanged: text part + the image's own content part.
  expect(sent.messages[0]?.role).toBe('user');
  expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
  expect(parts[1]?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ kind: 'chat-refine', inputImageIds: [SEED_ID] });
});
