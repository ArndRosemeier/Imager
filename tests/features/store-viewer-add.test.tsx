import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { storedImageSchema, type StoredImage } from '@/domain/image';
import { DEFAULT_SETTINGS } from '@/domain/settings';
import { Gallery } from '@/features/gallery/Gallery';
import { StoreArea } from '@/features/store/StoreArea';
import { storePushApi, type StorePushApi } from '@/features/store/storePush';
import { uploadStoredImages } from '@/features/store/storeTransfer';
import { sha256Hex } from '@/lib/sha256';
import { parseImageObject, type FolderIndex } from '@/server/store-files';
import { createFolder } from '@/server/store-folders';
import type { StoreConnection } from '@/server/store-session';
import type { StoreTarget, WhoAmI } from '@/server/store-client';

import { FakeServerStore } from '../server/fakeStore';

/**
 * docs/17 row 48 — THE IMAGE VIEWER'S "ADD TO STORE" BUTTON, and the substantive
 * half of it: "if it's not already there".
 *
 * THE PIN THAT MATTERS is the identity rule. The store holds WebP q90, so the
 * LOCAL picture's bytes are never the stored bytes: a naive
 * `sha256(local) == sha256(stored payload)` reports "not there" for ever and the
 * button would offer to duplicate every image on every visit. The identity the
 * app actually uses is `sourceSha256` — the SHA-256 of the ORIGINAL bytes,
 * recorded next to the object at push time (docs/17 row 45) — and this suite
 * proves it end to end: push once through the viewer, re-open the SAME image,
 * and the button says "Already in Alice" while the stored payload demonstrably
 * hashes to something else.
 *
 * The other arms are the owner's own clauses: the button exists only when the
 * host wired it, it is disabled with a REASON when there is no key or the key is
 * refused (never a button that silently does nothing), a refused PUT is a loud
 * toast carrying the service's reason, it cannot double-push, and the tags the
 * picture had locally are what the store view filters by afterwards.
 *
 * NOTE ON THE TEST DOUBLES: the canvas/decoder pair below mirrors the real
 * contract (the real NAME, the real signature, the real async-ness — ledger rows
 * 14/15: a double that invents an API certifies code the browser refuses). It is
 * deliberately local rather than shared with `tests/features/store-push.test.tsx`
 * and `tests/features/store-panel.test.tsx`: those two already carry DIFFERENT
 * doubles (this one derives the size from the source bytes; the store panel's is
 * a fixed 1200×900), so folding them into one helper would silently change a
 * landed suite's semantics. Recorded as debt in the ledger row.
 */

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Test setup: missing ${what}`);
  return value;
}

const WHO: WhoAmI = {
  id: 'key-1',
  label: 'alice',
  stores: ['imager'],
  perms: ['read', 'write', 'delete'],
  expiresAt: null,
  lastUsedAt: null,
};

let store: FakeServerStore;

function target(): StoreTarget {
  return { baseUrl: 'https://store.example', store: 'imager', key: 'ssk_test_KEY' };
}

function connection(): StoreConnection {
  return { target: target(), who: WHO, defaultFolderSlug: 'alice' };
}

/** The dimensions the fake decoder reads out of the source bytes, so "the
 * stored size is the SOURCE's" is assertable from the bytes themselves. */
function sourceBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    7,
    7,
    7,
    7,
  ]);
}

class FakeCanvas {
  readonly width: number;
  readonly height: number;
  private readonly context: { drawImage: () => void };
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.context = { drawImage: () => undefined };
  }
  getContext(): { drawImage: () => void } {
    return this.context;
  }
  convertToBlob(options: { type: string; quality?: number }): Promise<Blob> {
    return Promise.resolve(
      new Blob([new Uint8Array([this.width % 256, this.height % 256, 42])], { type: options.type }),
    );
  }
}

function fakeDecode(blob: Blob): Promise<ImageBitmap> {
  return blob.arrayBuffer().then((buffer): Promise<ImageBitmap> => {
    const bytes = new Uint8Array(buffer);
    const width = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    const height = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    if (width === 0 || height === 0) {
      return Promise.reject(new Error('The source image could not be decoded'));
    }
    return Promise.resolve({ width, height, close: () => undefined } as unknown as ImageBitmap);
  });
}

/** One LOCAL gallery row (a PNG, like a generated image really is here). */
function localRow(input: {
  id: string;
  prompt: string;
  tags: string[];
  width: number;
  height: number;
  createdAt: number;
}): StoredImage {
  return storedImageSchema.parse({
    id: input.id,
    bytes: sourceBytes(input.width, input.height),
    mimeType: 'image/png',
    width: input.width,
    height: input.height,
    prompt: input.prompt,
    model: 'google/gemini-3-pro-image',
    source: 'generated',
    createdAt: input.createdAt,
    runId: 'run-1',
    favorite: false,
    tags: input.tags,
  });
}

async function seedSettings(serverStoreKey: string): Promise<void> {
  await db.settings.put({
    ...DEFAULT_SETTINGS,
    id: 'settings',
    serverStoreKey,
    serverStoreFolder: 'alice',
  });
}

/** Alice's folder, empty — the destination a fresh push targets. */
async function seedAlice(): Promise<void> {
  await createFolder(target(), { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
}

/** Push a LOCAL row into the store through the app's OWN uploader, so a fixture
 * that is "already there" is exactly what a real push leaves behind. */
async function pushThroughTheApp(row: StoredImage): Promise<void> {
  const results = await uploadStoredImages(connection(), 'alice', [row], () => undefined);
  const only = must(results[0], 'the upload result');
  expect(only.phase).toBe('done');
}

function readIndex(slug: string): FolderIndex {
  const text = new TextDecoder().decode(must(store.read(`folder-${slug}-index`), 'the folder index'));
  return JSON.parse(text) as FolderIndex;
}

function storedObject(name: string): { header: Record<string, unknown>; bytes: Uint8Array<ArrayBuffer> } {
  const text = new TextDecoder().decode(must(store.read(name), `the object ${name}`));
  const object = parseImageObject(text);
  const { body: _body, bytes, ...header } = object;
  return { header, bytes };
}

/**
 * Forget the SETUP traffic (creating a folder is itself two PUTs), so an
 * assertion can see exactly what the button did and nothing else.
 */
function forgetSetup(): void {
  store.requests.length = 0;
}

/** Gallery + the app's ONE notice surface (toasts render nowhere without it). */
function renderViewer(storePush?: StorePushApi): ReturnType<typeof render> {
  return render(
    <>
      <Gallery storePush={storePush} />
      <Toaster />
    </>,
  );
}

async function openLightbox(prompt: string): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  const tile = await screen.findByRole('button', { name: `Open image: ${prompt}` });
  await user.click(tile);
  await screen.findByRole('dialog', { name: 'Image details' });
  return user;
}

beforeEach(async () => {
  store = new FakeServerStore();
  store.install();
  globalThis.OffscreenCanvas = FakeCanvas as unknown as typeof OffscreenCanvas;
  globalThis.createImageBitmap = fakeDecode as unknown as typeof createImageBitmap;
  await Promise.all([
    db.settings.clear(),
    db.images.clear(),
    db.runs.clear(),
    db.conversations.clear(),
    db.storeObjects.clear(),
    db.storeThumbs.clear(),
  ]);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

it('the viewer offers the store button ONLY when the host wired it, and the other actions are untouched either way', async () => {
  await seedSettings('');
  await db.images.bulkPut([localRow({ id: 'a', prompt: 'a wizard tower', tags: [], width: 900, height: 600, createdAt: 1 })]);

  // NOT wired: every existing action is there, and NO store affordance is
  // invented (the `onRefine`/`onChat` discipline, docs/17 row 48).
  const without = renderViewer();
  await openLightbox('a wizard tower');
  const dialog = screen.getByRole('dialog', { name: 'Image details' });
  expect(within(dialog).getByRole('button', { name: 'Save as…' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Add to store' })).not.toBeInTheDocument();
  without.unmount();

  // WIRED, but with NO key: the capability is visible, DISABLED, with the reason
  // — never a button that silently does nothing — and nothing was requested.
  renderViewer(storePushApi);
  await openLightbox('a wizard tower');
  const button = screen.getByRole('button', { name: 'Add to store' });
  expect(button).toBeDisabled();
  expect(screen.getByText(/No ServerStore key yet\. Add one on the Store tab/)).toBeInTheDocument();
  expect(store.requests).toEqual([]);
  // Every other action still works without a store.
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Save as…' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeEnabled();
});

it('a key the store REFUSES disables the button with that reason, and the rest of the viewer still works', async () => {
  await seedSettings('ssk_the_wrong_key');
  await seedAlice();
  await db.images.bulkPut([localRow({ id: 'a', prompt: 'a wizard tower', tags: [], width: 900, height: 600, createdAt: 1 })]);
  forgetSetup();

  renderViewer(storePushApi);
  await openLightbox('a wizard tower');

  const button = await screen.findByRole('button', { name: 'Add to store' });
  expect(button).toBeDisabled();
  expect(await screen.findByText(/could not be reached or refused this key/)).toBeInTheDocument();
  // It did ask, and it did not write.
  expect(store.requests.some((request) => request.target === '/whoami')).toBe(true);
  expect(store.requests.filter((request) => request.method === 'PUT')).toEqual([]);
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
});

it('a key with NO folder record of its own is disabled with the proposed name, and writes nothing', async () => {
  await seedSettings('ssk_test_KEY');
  await db.images.bulkPut([localRow({ id: 'a', prompt: 'a wizard tower', tags: [], width: 900, height: 600, createdAt: 1 })]);
  forgetSetup();

  renderViewer(storePushApi);
  await openLightbox('a wizard tower');

  const button = await screen.findByRole('button', { name: 'Add to store' });
  expect(button).toBeDisabled();
  // The proposed NAME is named as a proposal (ownership is the key id, docs/17
  // row 50), never presented as a fact about a folder that exists.
  expect(
    await screen.findByText(/No folder record in the store owns this key yet/),
  ).toBeInTheDocument();
  expect(screen.getByText(/The name the app proposes for it is "alice"/)).toBeInTheDocument();
  expect(store.requests.filter((request) => request.method === 'PUT')).toEqual([]);
});

it('an image ALREADY in the store is recognised from its source identity — although the store re-encoded it to WebP', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAlice();
  const row = localRow({ id: 'a', prompt: 'a wizard tower', tags: ['orc'], width: 900, height: 600, createdAt: 1 });
  await db.images.bulkPut([row]);
  await pushThroughTheApp(row);
  forgetSetup();

  // THE PREMISE THAT MAKES THE NAIVE CHECK WRONG, measured: the stored payload
  // is WebP and hashes to something ELSE than the local PNG bytes.
  const stored = storedObject('i-alice-000001');
  expect(stored.header.mimeType).toBe('image/webp');
  const localSha = await sha256Hex(row.bytes);
  expect(await sha256Hex(stored.bytes)).not.toBe(localSha);
  // …and the recorded source identity is what the local bytes DO hash to.
  expect(stored.header.sourceSha256).toBe(localSha);

  renderViewer(storePushApi);
  await openLightbox('a wizard tower');

  const button = await screen.findByRole('button', { name: 'Already in Alice' });
  expect(button).toBeDisabled();
  expect(screen.getByText(/Already in the store as i-alice-000001\. Nothing was uploaded\./)).toBeInTheDocument();
  // A disabled control cannot be clicked into a duplicate; and no write happened
  // while merely LOOKING at the image.
  expect(store.requests.filter((request) => request.method === 'PUT')).toEqual([]);
});

it('pushing from the viewer goes through the ONE encoder, carries the local metadata, and the second look says already there', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAlice();
  const row = localRow({
    id: 'a',
    prompt: 'a wizard tower at dusk',
    tags: ['orc', 'forest'],
    width: 1200,
    height: 900,
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  await db.images.bulkPut([row]);
  forgetSetup();

  const first = renderViewer(storePushApi);
  const user = await openLightbox('a wizard tower at dusk');

  const button = await screen.findByRole('button', { name: 'Add to store' });
  expect(button).toBeEnabled();
  await user.click(button);

  // The confirmation names WHERE it landed and WHAT it became.
  expect(await screen.findByText('Added to Alice')).toBeInTheDocument();
  expect(screen.getByText(/i-alice-000001 — WebP at quality 90/)).toBeInTheDocument();

  // The exact writes: ONE image object, then its folder index — and nothing else.
  const puts = store.requests.filter((request) => request.method === 'PUT');
  expect(puts.map((request) => `${request.method} ${request.target} ${String(request.status)}`)).toEqual([
    'PUT i-alice-000001 201',
    'PUT folder-alice-index 201',
  ]);

  // The object is WebP q90 at the SOURCE pixel size, and it carries the row's
  // own prompt/model/source/tags/createdAt (the tags are the point).
  const stored = storedObject('i-alice-000001');
  expect(stored.header.mimeType).toBe('image/webp');
  expect(stored.header.quality).toBe(90);
  expect(stored.header.width).toBe(1200);
  expect(stored.header.height).toBe(900);
  expect(stored.header.prompt).toBe('a wizard tower at dusk');
  expect(stored.header.model).toBe('google/gemini-3-pro-image');
  expect(stored.header.source).toBe('generated');
  expect(stored.header.tags).toEqual(['orc', 'forest']);
  expect(stored.header.createdAt).toBe(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString());
  expect(stored.header.sourceSha256).toBe(await sha256Hex(row.bytes));

  // The folder index lists it, with the same source identity.
  const index = readIndex('alice');
  expect(index.images).toHaveLength(1);
  const entry = must(index.images[0], 'the indexed image');
  expect(entry.name).toBe('i-alice-000001');
  expect(entry.sourceSha256).toBe(await sha256Hex(row.bytes));
  expect(entry.tags).toEqual(['orc', 'forest']);

  // IN-SESSION: the button it just used now reports the answer.
  expect(await screen.findByRole('button', { name: 'Already in Alice' })).toBeDisabled();
  first.unmount();

  // THE SECOND LOOK, from the STORE this time (a fresh mount, a fresh check):
  // the identity rule survives the re-encode that already happened.
  renderViewer(storePushApi);
  await openLightbox('a wizard tower at dusk');
  expect(await screen.findByRole('button', { name: 'Already in Alice' })).toBeDisabled();
  expect(store.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
});

it('a refused PUT is a LOUD toast carrying the store\'s reason, and the button is not left busy', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAlice();
  await db.images.bulkPut([localRow({ id: 'a', prompt: 'a wizard tower', tags: [], width: 900, height: 600, createdAt: 1 })]);
  forgetSetup();

  renderViewer(storePushApi);
  const user = await openLightbox('a wizard tower');
  const button = await screen.findByRole('button', { name: 'Add to store' });

  // `413`: the service's own oversized-object reason reaches the owner verbatim.
  store.failNextPut('i-alice-000001', {
    status: 413,
    code: 'payload_too_large',
    message: 'Object exceeds the 67108864 byte limit.',
  });
  await user.click(button);
  expect(await screen.findByText(/Could not add this image to the store/)).toBeInTheDocument();
  expect(
    await screen.findByText(/Object exceeds the 67108864 byte limit\./),
  ).toBeInTheDocument();

  // Not stuck busy, and no duplicate: the failed PUT freed its sequence, so the
  // retry legitimately targets the same name — with the `429`'s own reason.
  const retry = await screen.findByRole('button', { name: 'Add to store' });
  expect(retry).toBeEnabled();
  store.failNextPut('i-alice-000001', {
    status: 429,
    code: 'rate_limited',
    message: 'Slow down.',
    retryAfterSeconds: 30,
  });
  await user.click(retry);
  expect(await screen.findByText(/Slow down\. — the store asked to wait 30s \(Retry-After\)/)).toBeInTheDocument();
  // And the picture is NOT in the store: nothing was silently accepted.
  expect(store.read('i-alice-000001')).toBeUndefined();

  // `403`: a key that may read but not write is the third refusal the store
  // documents, and it reaches the owner with its own reason — never as a
  // successful push and never as a silent no-op.
  store.failNextPut('i-alice-000001', {
    status: 403,
    code: 'forbidden',
    message: 'This key is not allowed to write to the imager store.',
  });
  await user.click(await screen.findByRole('button', { name: 'Add to store' }));
  expect(
    await screen.findByText(/This key is not allowed to write to the imager store\./),
  ).toBeInTheDocument();
  expect(store.read('i-alice-000001')).toBeUndefined();
});

it('the tags a picture had locally are what the STORE view filters by after a viewer push', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAlice();
  const row = localRow({ id: 'a', prompt: 'a wizard tower', tags: ['orc', 'forest'], width: 900, height: 600, createdAt: 1 });
  await db.images.bulkPut([row]);

  const viewer = renderViewer(storePushApi);
  const user = await openLightbox('a wizard tower');
  await user.click(await screen.findByRole('button', { name: 'Add to store' }));
  await screen.findByText('Added to Alice');
  // The viewer goes away first: its own tag bar would otherwise be a second
  // "Tags" row on screen and this pin would prove nothing about the store pane.
  viewer.unmount();

  // The store's OWN pane, over the listing it reads back: the derived tag bar
  // carries the local tag, and filtering by it finds exactly the pushed image.
  render(<StoreArea />);
  expect(await screen.findByText(/Showing 1 of 1 stored images/)).toBeInTheDocument();
  const tags = must(screen.getByText('Tags').parentElement, 'the tag bar row');
  const orc = await within(tags).findByRole('button', { name: 'orc (1 image)' });
  expect(within(tags).getByRole('button', { name: 'forest (1 image)' })).toBeInTheDocument();
  await user.click(orc);
  expect(await screen.findByText(/Showing 1 of 1 stored images/)).toBeInTheDocument();
});

it('a folder that exists without a readable index is "cannot tell", not a guessed push', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAlice();
  await db.images.bulkPut([localRow({ id: 'a', prompt: 'a wizard tower', tags: [], width: 900, height: 600, createdAt: 1 })]);
  // A folder RECORD with no index at all: the listing reports an image that no
  // index can account for, so a duplicate cannot be ruled out.
  store.seed('folder-ghost', JSON.stringify({ v: 1, slug: 'ghost', owner: 'key-2', displayName: 'Ghost', private: false, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }));
  store.seed('i-ghost-000001', 'not an object this app wrote');
  forgetSetup();

  renderViewer(storePushApi);
  await openLightbox('a wizard tower');

  const button = await screen.findByRole('button', { name: 'Add to store' });
  expect(button).toBeDisabled();
  expect(await screen.findByText(/Cannot tell whether this image is already in the store/)).toBeInTheDocument();
  expect(store.requests.filter((request) => request.method === 'PUT')).toEqual([]);
});
