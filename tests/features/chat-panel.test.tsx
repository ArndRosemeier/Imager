import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { REFERENCE_MAX_EDGE_PX, bytesToDataUrl } from '@/features/refine/reference';
import { resetImageModelCache } from '@/llm/imageModels';
import { resetModelCache } from '@/llm/models';
import { jsonResponse } from '../helpers';

const modelsJson = readFileSync('tests/fixtures/models-trimmed.json', 'utf8');
const imagesModelsJson = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');
const CHAT_MODEL = 'google/gemini-2.5-flash-image';
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

/** The decoders: every image "decodes" at 2000×1000, so ANY stored image must
 * be re-encoded down to the reference cap when it is replayed to the model. */
function decodeAt(width: number, height: number): () => Promise<ImageBitmap> {
  return () => Promise.resolve({ width, height, close: () => undefined } as unknown as ImageBitmap);
}

class FakeCanvas {
  static sizes: { width: number; height: number }[] = [];
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    FakeCanvas.sizes.push({ width, height });
  }
  getContext(): { canvas: FakeCanvas; drawImage: () => void } {
    return { canvas: this, drawImage: () => undefined };
  }
  toDataURL(mimeType: string): string {
    return bytesToDataUrl(
      new TextEncoder().encode(`${String(this.width)}x${String(this.height)}`),
      mimeType,
    );
  }
}

function decodeSizes(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return new TextDecoder().decode(
    Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0)),
  );
}

function chatAnswer(text: string): Response {
  return jsonResponse({
    model: CHAT_MODEL,
    choices: [
      {
        message: {
          role: 'assistant',
          content: text,
          images: [{ image_url: { url: DATA_URL } }],
        },
      },
    ],
    usage: { cost: 0.2 },
  });
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(await screen.findByLabelText('Message'), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(async () => {
  resetImageModelCache();
  resetModelCache();
  await Promise.all([db.settings.clear(), db.images.clear(), db.runs.clear(), db.conversations.clear()]);
  vi.stubGlobal('createImageBitmap', decodeAt(2000, 1000));
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  FakeCanvas.sizes = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('an empty refinement pick disables Send with the reason and falls back to NOTHING', async () => {
  stubFetch(() => jsonResponse({}));
  // The image model IS a chat-capable model, so a stray fallback would be
  // visible as a request carrying it — the pin is that no request happens.
  await updateSettings({
    openRouterApiKey: 'sk',
    imageModel: 'google/gemini-3-pro-image-preview',
    refineChatModel: '',
  });
  render(<App initialTab="Chat" />);
  expect(await screen.findByText(/no fallback to the image model/)).toBeInTheDocument();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Message'), 'make the sky darker');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(posts).toEqual([]);
  await expect(db.conversations.count()).resolves.toBe(0);
});

it('with no API key the composer is blocked before anything else', async () => {
  stubFetch(() => jsonResponse({}));
  await updateSettings({ openRouterApiKey: '', refineChatModel: CHAT_MODEL });
  render(<App initialTab="Chat" />);
  expect(await screen.findByText('Enter an OpenRouter API key in Settings.')).toBeInTheDocument();
  await userEvent.setup().type(screen.getByLabelText('Message'), 'hello');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(posts).toEqual([]);
});

it('a model that cannot chat-refine is refused visibly, with no request', async () => {
  stubFetch(() => jsonResponse({}));
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: 'openai/gpt-image-1' });
  render(<App initialTab="Chat" />);
  expect(await screen.findByText(/cannot answer with text AND images/)).toBeInTheDocument();
  await userEvent.setup().type(screen.getByLabelText('Message'), 'make the sky darker');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(posts).toEqual([]);
});

it('a turn sends modalities + the refineChatModel, stores the image in the gallery and records the run', async () => {
  stubFetch(() => chatAnswer('Darker sky.'));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: 'openai/gpt-image-1', refineChatModel: CHAT_MODEL });
  render(<App initialTab="Chat" />);
  const user = userEvent.setup();
  await send(user, 'make the sky darker');

  expect(await screen.findByText('Darker sky.')).toBeInTheDocument();
  const sent = JSON.parse(posts[0] ?? '') as {
    model: string;
    modalities: string[];
    messages: { role: string; content: string }[];
  };
  expect(sent.model).toBe(CHAT_MODEL);
  expect(sent.modalities).toEqual(['text', 'image']);
  expect(sent.messages).toEqual([{ role: 'user', content: 'make the sky darker' }]);

  await expect(db.images.count()).resolves.toBe(1);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    kind: 'chat-refine',
    model: CHAT_MODEL,
    prompt: 'make the sky darker',
    requestedCount: 1,
    receivedCount: 1,
    inputImageIds: [],
    costUsd: 0.2,
    error: null,
  });
  const conversations = await db.conversations.toArray();
  expect(conversations).toHaveLength(1);
  expect(conversations[0]).toMatchObject({ title: 'make the sky darker', model: CHAT_MODEL });
  expect(conversations[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(conversations[0]?.messages[1]?.imageIds).toHaveLength(1);
  // Spend is shown per turn and in total.
  expect(screen.getByText(/Cost: \$0\.2000/)).toBeInTheDocument();
  expect(screen.getByText(/total \$0\.2000/)).toBeInTheDocument();

  // The generated image is a normal gallery image with its provenance.
  await user.click(screen.getByRole('tab', { name: 'Generate' }));
  const gallery = screen.getByRole('region', { name: 'Gallery' });
  expect(
    await within(gallery).findByRole('button', { name: /Open image: make the sky darker/ }),
  ).toBeInTheDocument();
});

it('the SECOND turn carries the first user text AND the first image, re-encoded to the reference cap', async () => {
  let call = 0;
  stubFetch(() => {
    call += 1;
    return chatAnswer(call === 1 ? 'Darker sky.' : 'Rain added.');
  });
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  render(<App initialTab="Chat" />);
  const user = userEvent.setup();
  await send(user, 'make the sky darker');
  expect(await screen.findByText('Darker sky.')).toBeInTheDocument();
  await send(user, 'now add rain');
  expect(await screen.findByText('Rain added.')).toBeInTheDocument();

  const second = JSON.parse(posts[1] ?? '') as {
    messages: { role: string; content: string; images?: { image_url: { url: string } }[] }[];
  };
  // The memory claim: user text 1, then assistant 1 WITH its image, then user 2.
  expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(second.messages[0]).toEqual({ role: 'user', content: 'make the sky darker' });
  expect(second.messages[1]?.content).toBe('Darker sky.');
  expect(second.messages[2]).toEqual({ role: 'user', content: 'now add rain' });
  const replayed = second.messages[1]?.images?.[0]?.image_url.url ?? '';
  expect(replayed.startsWith('data:image/png;base64,')).toBe(true);
  // 2000×1000 was re-encoded by the SHARED reference prep, long edge = cap.
  expect(FakeCanvas.sizes).toEqual([{ width: REFERENCE_MAX_EDGE_PX, height: 512 }]);
  expect(decodeSizes(replayed)).toBe('1024x512');

  // Turn 2 records what it sent back, and both turns stay in the conversation.
  const runs = await db.runs.toArray();
  const secondRun = runs.find((run) => run.prompt === 'now add rain');
  expect(secondRun).toMatchObject({ kind: 'chat-refine', receivedCount: 1 });
  expect(secondRun?.inputImageIds).toHaveLength(1);
  await expect(db.images.count()).resolves.toBe(2);
});

it('a 200 error envelope → toast + the failed turn visible and stored, nothing stored as an image', async () => {
  stubFetch(() => jsonResponse({ error: { code: 400, message: 'Prompt was refused' } }));
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  render(<App initialTab="Chat" />);
  const user = userEvent.setup();
  await send(user, 'make the sky darker');

  expect(await screen.findByText(/Turn failed: .*Prompt was refused/)).toBeInTheDocument();
  expect(await screen.findByText('Chat turn failed')).toBeInTheDocument();
  await expect(db.images.count()).resolves.toBe(0);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ kind: 'chat-refine', receivedCount: 0, costUsd: null });
  expect(runs[0]?.error).toMatch(/Prompt was refused/);
  const conversation = (await db.conversations.toArray())[0];
  expect(conversation?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(conversation?.messages[1]?.error).toMatch(/Prompt was refused/);
  // The composer is usable again: the only reason left is the empty draft.
  expect(screen.getByText('Type a message to send.')).toBeInTheDocument();
});

it('a completion with no text and no images is a loud failure, and the failed turn is recorded', async () => {
  stubFetch(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: ' ' } }] }));
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  render(<App initialTab="Chat" />);
  const user = userEvent.setup();
  await send(user, 'make the sky darker');

  expect(await screen.findByText(/neither text nor images/)).toBeInTheDocument();
  await expect(db.images.count()).resolves.toBe(0);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]?.error).toMatch(/neither text nor images/);
});

it('a conversation and its image ids survive a reload and can be continued', async () => {
  let call = 0;
  stubFetch(() => {
    call += 1;
    return chatAnswer(call === 1 ? 'Darker sky.' : 'Rain added.');
  });
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  const first = render(<App initialTab="Chat" />);
  const user = userEvent.setup();
  await send(user, 'make the sky darker');
  expect(await screen.findByText('Darker sky.')).toBeInTheDocument();
  const imageIds = (await db.images.toArray()).map((image) => image.id);
  expect(imageIds).toHaveLength(1);
  first.unmount();

  render(<App initialTab="Chat" />);
  await user.click(await screen.findByRole('button', { name: /make the sky darker/ }));
  expect(await screen.findByText('Darker sky.')).toBeInTheDocument();
  // The stored image id still resolves to a real gallery image.
  await expect(db.images.get(imageIds[0] ?? '')).resolves.toBeDefined();

  await send(user, 'now add rain');
  expect(await screen.findByText('Rain added.')).toBeInTheDocument();
  const runs = await db.runs.toArray();
  expect(runs.map((run) => run.prompt).sort()).toEqual(['make the sky darker', 'now add rain']);
  await expect(db.images.count()).resolves.toBe(2);
});

it('a conversation whose image left the gallery fails loudly and records the failed turn', async () => {
  stubFetch(() => jsonResponse({}));
  await updateSettings({ openRouterApiKey: 'sk', refineChatModel: CHAT_MODEL });
  await db.conversations.put({
    id: 'conv-missing',
    title: 'seeded conversation',
    model: CHAT_MODEL,
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'u1',
        role: 'user',
        text: 'make it rain',
        imageIds: [],
        runId: '',
        model: '',
        costUsd: null,
        error: null,
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        text: 'Rain added.',
        imageIds: ['deleted-image'],
        runId: 'r1',
        model: CHAT_MODEL,
        costUsd: 0.1,
        error: null,
        createdAt: 2,
      },
    ],
  });
  render(<App initialTab="Chat" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /seeded conversation/ }));
  await user.type(await screen.findByLabelText('Message'), 'now add snow');
  await user.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByText(/Turn failed: .*no longer in the gallery/)).toBeInTheDocument();
  expect(posts).toEqual([]);
  await waitFor(async () => {
    const runs = await db.runs.toArray();
    expect(runs).toHaveLength(1);
  });
  const runs = await db.runs.toArray();
  expect(runs[0]?.error).toMatch(/no longer in the gallery/);
  const conversation = await db.conversations.get('conv-missing');
  expect(conversation?.messages.at(-1)?.error).toMatch(/no longer in the gallery/);
});
