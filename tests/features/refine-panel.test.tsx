import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { saveUploadedImage } from '@/db/imageRepo';
import { updateSettings } from '@/db/settingsRepo';
import { REFERENCE_MAX_EDGE_PX, prepareReference } from '@/features/refine/reference';
import type { StoredImage } from '@/domain/image';
import { resetImageModelCache } from '@/llm/imageModels';
import { jsonResponse } from '../helpers';

const imagesModels = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');
const MODEL = 'openai/gpt-image-1';
const SOURCE_ID = 'source-1';
let posts: string[] = [];

/**
 * A minimal `OffscreenCanvas` stand-in that implements the REAL contract this
 * seam calls: `getContext('2d')` plus the ASYNCHRONOUS `convertToBlob({type})`
 * returning a `Blob`. It deliberately has NO `toDataURL` — the method the real
 * OffscreenCanvas does not have, whose absence was the live bug (a double that
 * added it certified code that threw in every real browser). It records the
 * size it was asked to draw at and encodes THAT size into the produced blob, so
 * a test can decode the payload and see the dimensions actually sent.
 */
class FakeOffscreenCanvas {
  static sizes: { width: number; height: number }[] = [];
  static encodeCalls: { type: string | undefined }[] = [];
  readonly width: number;
  readonly height: number;
  private readonly context: { canvas: FakeOffscreenCanvas; drawImage: () => void };
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    FakeOffscreenCanvas.sizes.push({ width, height });
    this.context = { canvas: this, drawImage: () => undefined };
  }
  getContext(): { canvas: FakeOffscreenCanvas; drawImage: () => void } {
    return this.context;
  }
  convertToBlob(options?: ImageEncodeOptions): Promise<Blob> {
    FakeOffscreenCanvas.encodeCalls.push({ type: options?.type });
    return Promise.resolve(
      new Blob([new TextEncoder().encode(`${String(this.width)}x${String(this.height)}`)], {
        type: options?.type ?? 'image/png',
      }),
    );
  }
}

function decodeSizes(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice('data:'.length, comma);
  expect(header.endsWith(';base64')).toBe(true);
  return new TextDecoder().decode(
    Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0)),
  );
}

function stubFetch(imagesBody: () => Response): void {
  posts = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/images/models')) return Promise.resolve(new Response(imagesModels));
    if (url.endsWith('/images')) {
      posts.push(init?.body as string);
      return Promise.resolve(imagesBody());
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function decodeAt(width: number, height: number): () => Promise<ImageBitmap> {
  return () =>
    Promise.resolve({
      width,
      height,
      close: () => undefined,
    } as unknown as ImageBitmap);
}

async function seedSource(overrides: Partial<StoredImage> = {}): Promise<void> {
  await db.images.put({
    id: SOURCE_ID,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/jpeg',
    width: 2000,
    height: 1000,
    prompt: 'seeded source',
    model: 'openai/gpt-image-1',
    source: 'generated',
    createdAt: 1,
    runId: 'seed-run',
    favorite: false,
    tags: [],
    ...overrides,
  });
}

/** Gallery tab → thumb → lightbox → "Refine this": the cross-tab source path. */
async function pickSourceFromGallery(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));
  await user.click(await screen.findByRole('button', { name: /Open image: seeded source/ }));
  await user.click(within(screen.getByRole('dialog', { name: 'Image details' })).getByRole('button', { name: 'Refine this' }));
}

beforeEach(async () => {
  resetImageModelCache();
  await Promise.all([db.settings.clear(), db.images.clear(), db.runs.clear()]);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  FakeOffscreenCanvas.sizes = [];
  FakeOffscreenCanvas.encodeCalls = [];
  // jsdom has no canvas at all: the seam's `OffscreenCanvas` branch is the one
  // exercised, with the size it is asked to draw at recorded.
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('no source chosen → Refine disabled with the reason, and no request is sent', async () => {
  stubFetch(() => jsonResponse({}));
  vi.stubGlobal('createImageBitmap', decodeAt(64, 32));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: MODEL });
  render(<App />);
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Refine' }));
  await screen.findByRole('button', { name: 'Refine' });
  expect(await screen.findByText('Choose or upload an image to refine')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refine' })).toBeDisabled();
  expect(posts).toEqual([]);
});

it('refine sends the source as a downscaled input_reference and records kind refine', async () => {
  stubFetch(() =>
    jsonResponse({ data: [{ b64_json: btoa('x'), media_type: 'image/png' }], usage: { cost: 0.5 } }),
  );
  vi.stubGlobal('createImageBitmap', decodeAt(2000, 1000));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: MODEL });
  await seedSource();
  render(<App />);
  const user = userEvent.setup();
  await pickSourceFromGallery(user);
  await screen.findByRole('img', { name: /Refinement source: seeded source/ });
  await user.type(screen.getByLabelText('Instruction'), 'make it night, keep the layout');
  await user.click(screen.getByRole('button', { name: 'Refine' }));

  expect(await screen.findByText(/\$0\.5000/)).toBeInTheDocument();
  const sent = JSON.parse(posts[0] ?? '') as {
    model: string;
    n: number;
    prompt: string;
    input_references: { type: string; image_url: { url: string } }[];
  };
  expect(sent.model).toBe(MODEL);
  expect(sent.prompt).toBe('make it night, keep the layout');
  expect(sent.n).toBe(1);
  expect(sent.input_references).toHaveLength(1);
  const reference = sent.input_references[0];
  expect(reference?.type).toBe('image_url');
  expect(reference?.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  // The 2000×1000 source was downscaled to a long edge of exactly the cap.
  expect(FakeOffscreenCanvas.sizes).toEqual([{ width: REFERENCE_MAX_EDGE_PX, height: 512 }]);
  // The OffscreenCanvas path encodes through the REAL contract: the async
  // `convertToBlob({type})`, with the source mime — never `toDataURL`.
  expect(FakeOffscreenCanvas.encodeCalls).toEqual([{ type: 'image/jpeg' }]);
  expect(decodeSizes(reference?.image_url.url ?? '')).toBe('1024x512');

  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    kind: 'refine',
    inputImageIds: [SOURCE_ID],
    model: MODEL,
    prompt: 'make it night, keep the layout',
    receivedCount: 1,
    costUsd: 0.5,
    error: null,
  });
  await expect(db.images.count()).resolves.toBe(2);
  const produced = (await db.images.toArray()).filter((image) => image.id !== SOURCE_ID);
  expect(produced[0]).toMatchObject({ runId: runs[0]?.id });
});

it('refine sends the REFINEMENT model when one is picked (ledger row 11)', async () => {
  stubFetch(() =>
    jsonResponse({ data: [{ b64_json: btoa('x'), media_type: 'image/png' }], usage: { cost: 0.25 } }),
  );
  vi.stubGlobal('createImageBitmap', decodeAt(2000, 1000));
  // The image model and the refinement model are DIFFERENT, so a stray
  // `imageModel` in the request body is visible rather than accidental.
  await updateSettings({
    openRouterApiKey: 'sk',
    imageModel: MODEL,
    refineChatModel: 'google/gemini-2.5-flash-image',
  });
  await seedSource();
  render(<App />);
  const user = userEvent.setup();
  await pickSourceFromGallery(user);
  await screen.findByRole('img', { name: /Refinement source: seeded source/ });
  await user.type(screen.getByLabelText('Instruction'), 'make it night');
  await user.click(screen.getByRole('button', { name: 'Refine' }));

  expect(await screen.findByText(/\$0\.2500/)).toBeInTheDocument();
  const sent = JSON.parse(posts[0] ?? '') as { model: string };
  expect(sent.model).toBe('google/gemini-2.5-flash-image');
  const runs = await db.runs.toArray();
  expect(runs[0]).toMatchObject({ kind: 'refine', model: 'google/gemini-2.5-flash-image' });
});

it('refine falls back to the image model when no refinement model is picked', async () => {
  stubFetch(() =>
    jsonResponse({ data: [{ b64_json: btoa('x'), media_type: 'image/png' }], usage: { cost: 0.1 } }),
  );
  vi.stubGlobal('createImageBitmap', decodeAt(2000, 1000));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: MODEL, refineChatModel: '' });
  await seedSource();
  render(<App />);
  const user = userEvent.setup();
  await pickSourceFromGallery(user);
  await screen.findByRole('img', { name: /Refinement source: seeded source/ });
  await user.type(screen.getByLabelText('Instruction'), 'make it night');
  await user.click(screen.getByRole('button', { name: 'Refine' }));

  expect(await screen.findByText(/\$0\.1000/)).toBeInTheDocument();
  const sent = JSON.parse(posts[0] ?? '') as { model: string };
  expect(sent.model).toBe(MODEL);
});

it('a source that fails to decode → visible error + failed refine run, no request sent', async () => {
  stubFetch(() => jsonResponse({}));
  vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('broken image data')));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: MODEL });
  await seedSource();
  render(<App />);
  const user = userEvent.setup();
  await pickSourceFromGallery(user);
  await screen.findByRole('img', { name: /Refinement source: seeded source/ });
  await user.type(screen.getByLabelText('Instruction'), 'brighten it');
  await user.click(screen.getByRole('button', { name: 'Refine' }));

  expect(await screen.findByText(/Run failed: broken image data/)).toBeInTheDocument();
  expect(await screen.findByText('Refinement failed')).toBeInTheDocument();
  expect(posts).toEqual([]);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ kind: 'refine', inputImageIds: [SOURCE_ID], receivedCount: 0 });
  expect(runs[0]?.error).toMatch(/broken image data/);
  await expect(db.images.count()).resolves.toBe(1);
});

it('an upload is stored as source "uploaded" and appears in the gallery', async () => {
  stubFetch(() => jsonResponse({}));
  vi.stubGlobal('createImageBitmap', decodeAt(300, 200));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: MODEL });
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Refine' }));
  const file = new File([new Uint8Array([9, 9, 9])], 'holiday.jpg', { type: 'image/jpeg' });
  await user.upload(await screen.findByLabelText('Upload an image'), file);

  await waitFor(async () => {
    await expect(db.images.count()).resolves.toBe(1);
  });
  const stored = (await db.images.toArray())[0];
  expect(stored).toMatchObject({
    source: 'uploaded',
    prompt: 'holiday.jpg',
    mimeType: 'image/jpeg',
    width: 300,
    height: 200,
  });
  // The upload is an ordinary gallery row; the gallery is its own tab, so it
  // shows on the next visit with no refresh plumbing (docs/17 row 30).
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));
  const gallery = await screen.findByRole('region', { name: 'Gallery' });
  expect(await within(gallery).findByRole('button', { name: /Open image: holiday\.jpg/ })).toBeInTheDocument();
});

it('prepareReference leaves an image at or under the cap untouched', async () => {
  const small = new Blob([new Uint8Array([7, 7])], { type: 'image/png' });
  const prepared = await prepareReference(small, decodeAt(800, 600));
  expect(prepared).toMatchObject({ width: 800, height: 600, downscaled: false });
  expect(prepared.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(FakeOffscreenCanvas.sizes).toEqual([]);
});

it('an encode that yields an EMPTY blob THROWS instead of passing the oversized source through', async () => {
  class EmptyBlobCanvas extends FakeOffscreenCanvas {
    override convertToBlob(): Promise<Blob> {
      return Promise.resolve(new Blob([], { type: 'image/jpeg' }));
    }
  }
  vi.stubGlobal('OffscreenCanvas', EmptyBlobCanvas);
  const big = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  await expect(prepareReference(big, decodeAt(2000, 1000))).rejects.toThrow(/is empty/);
});

it('a zero-sized decode THROWS instead of passing the source through', async () => {
  const big = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  await expect(prepareReference(big, decodeAt(0, 0))).rejects.toThrow(/empty size/);
});

it('an encode failure during refine → visible error + failed run, no request sent', async () => {
  class FailingEncodeCanvas extends FakeOffscreenCanvas {
    override convertToBlob(): Promise<Blob> {
      return Promise.reject(new Error('the encoder refused the bitmap'));
    }
  }
  vi.stubGlobal('OffscreenCanvas', FailingEncodeCanvas);
  stubFetch(() => jsonResponse({}));
  vi.stubGlobal('createImageBitmap', decodeAt(2000, 1000));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: MODEL });
  await seedSource();
  render(<App />);
  const user = userEvent.setup();
  await pickSourceFromGallery(user);
  await screen.findByRole('img', { name: /Refinement source: seeded source/ });
  await user.type(screen.getByLabelText('Instruction'), 'make it night');
  await user.click(screen.getByRole('button', { name: 'Refine' }));

  expect(await screen.findByText(/Run failed: the encoder refused the bitmap/)).toBeInTheDocument();
  expect(await screen.findByText('Refinement failed')).toBeInTheDocument();
  expect(posts).toEqual([]);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ kind: 'refine', inputImageIds: [SOURCE_ID], receivedCount: 0 });
  expect(runs[0]?.error).toMatch(/the encoder refused the bitmap/);
  await expect(db.images.count()).resolves.toBe(1);
});

it('a model that publishes no input_references disables Refine with a reason', async () => {
  stubFetch(() => jsonResponse({}));
  vi.stubGlobal('createImageBitmap', decodeAt(64, 32));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: 'meta/muse-image' });
  render(<App />);
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Refine' }));
  expect(await screen.findByText(/does not accept reference images/)).toBeInTheDocument();
});

it('saveUploadedImage records the file and its own size', async () => {
  vi.stubGlobal('createImageBitmap', decodeAt(64, 48));
  const stored = await saveUploadedImage({
    bytes: new Uint8Array([5]),
    mimeType: 'image/png',
    fileName: 'shot.png',
  });
  expect(stored).toMatchObject({
    source: 'uploaded',
    prompt: 'shot.png',
    width: 64,
    height: 48,
    runId: '',
  });
});
