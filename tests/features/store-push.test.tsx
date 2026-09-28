import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { storedImageSchema, type StoredImage } from '@/domain/image';
import { DEFAULT_SETTINGS } from '@/domain/settings';
import { StoreArea } from '@/features/store/StoreArea';
import { sha256Hex } from '@/lib/sha256';
import { parseImageObject, type FolderIndex } from '@/server/store-files';
import { createFolder, ensureIndex, readDirectory, uploadImage } from '@/server/store-folders';
import type { StoreTarget, WhoAmI } from '@/server/store-client';

import { FakeServerStore } from '../server/fakeStore';

/**
 * docs/17 row 45 — THE LOCAL-LIBRARY PUSH.
 *
 * The owner's report: "i dont see how i can upload gallery images there." The
 * capability did not exist: the store's only upload control took files from the
 * DEVICE, so an image made in Imager had to be downloaded and re-uploaded. These
 * pins are the new path:
 *
 *  * N local images → N store objects through the ONE encoder (WebP q90, at the
 *    SOURCE pixel dimensions), with the row's prompt/model/tags/source/createdAt
 *    in the object header and the folder index listing them;
 *  * the store view's own tag filter then finds a pushed image by the tag it had
 *    locally (the tags survive the round trip);
 *  * ONE refused object does not abort the batch, and a `429` keeps its
 *    `Retry-After` on the failed row instead of being retried silently;
 *  * with no key the picker still shows the library and STATES why it cannot
 *    push, and makes no request at all.
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

/** The dimensions the fake decoder reads out of the source bytes, so "the
 * stored size is the SOURCE's" is assertable from the bytes themselves. */
function sourceBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(width >> 8) & 0xff, width & 0xff, (height >> 8) & 0xff, height & 0xff, 7, 7, 7, 7]);
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

/** The decoder double mirrors the REAL contract: dimensions come from the
 * picture, and a zero-sized header is a corrupt source (rejection). */
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

function localRow(input: {
  id: string;
  prompt: string;
  model: string;
  tags: string[];
  width: number;
  height: number;
  createdAt: number;
  favorite?: boolean;
}): StoredImage {
  return storedImageSchema.parse({
    id: input.id,
    bytes: sourceBytes(input.width, input.height),
    mimeType: 'image/png',
    width: input.width,
    height: input.height,
    prompt: input.prompt,
    model: input.model,
    source: 'generated',
    createdAt: input.createdAt,
    runId: 'run-1',
    favorite: input.favorite ?? false,
    tags: input.tags,
  });
}

async function seedLocal(rows: readonly StoredImage[]): Promise<void> {
  await db.images.bulkPut(rows.map((row) => storedImageSchema.parse(row)));
}

async function seedAliceFolder(): Promise<void> {
  await createFolder(target(), { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  for (const position of [1, 2]) {
    const directory = await readDirectory(target());
    const alice = must(
      directory.folders.find((folder) => folder.record.slug === 'alice'),
      'the alice folder',
    );
    const { index } = await ensureIndex(target(), alice, directory.byName);
    await uploadImage(
      target(),
      {
        slug: 'alice',
        bytes: new Uint8Array([position, 9, 9, 9]),
        mimeType: 'image/webp',
        width: 800,
        height: 600,
        quality: 90,
        prompt: `seeded ${String(position)}`,
        model: 'uploaded file',
        source: 'uploaded',
        tags: position === 1 ? ['orc', 'forest'] : ['orc'],
        sourceSha256: await sha256Hex(new Uint8Array([position, 9, 9, 9])),
        id: `seed-${String(position)}`,
        createdAt: new Date(2026, 0, position),
      },
      index,
      directory.entries.map((entry) => entry.name),
    );
  }
}

async function seedSettings(serverStoreKey: string): Promise<void> {
  await db.settings.put({
    ...DEFAULT_SETTINGS,
    id: 'settings',
    serverStoreKey,
    serverStoreFolder: 'alice',
  });
}

function readIndex(slug: string): FolderIndex {
  const text = new TextDecoder().decode(must(store.read(`folder-${slug}-index`), 'the folder index'));
  return JSON.parse(text) as FolderIndex;
}

function storedHeader(name: string): Record<string, unknown> {
  const text = new TextDecoder().decode(must(store.read(name), `the object ${name}`));
  const object = parseImageObject(text);
  const { body: _body, bytes: _bytes, ...header } = object;
  return header;
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

it('pushes N library images as WebP q90 at the SOURCE size, carrying prompt/model/tags/source/createdAt', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAliceFolder();
  await seedLocal([
    localRow({ id: 'loc-1', prompt: 'a local orc', model: 'acme/art-1', tags: ['orc', 'forest'], width: 1600, height: 900, createdAt: 1_700_000_000_000 }),
    localRow({ id: 'loc-2', prompt: 'a local forest', model: 'acme/art-1', tags: ['forest'], width: 640, height: 1024, createdAt: 1_700_000_001_000 }),
    localRow({ id: 'loc-3', prompt: 'a local favourite', model: 'acme/art-2', tags: [], width: 512, height: 512, createdAt: 1_700_000_002_000, favorite: true }),
  ]);
  render(<StoreArea />);
  const user = userEvent.setup();
  await screen.findByText(/Showing 2 of 2 stored images/);

  await user.click(screen.getByRole('button', { name: 'Add from gallery…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add images from your library' });
  await waitFor(() => {
    expect(within(dialog).getByText(/Showing 3 of 3 images/)).toBeInTheDocument();
  });
  // Destination defaults to the folder the dialog is showing (your own here).
  expect(within(dialog).getByText('alice')).toBeInTheDocument();

  // The library pane uses the SAME tag seam: filter to `forest` (2 of 3).
  const tags = must(within(dialog).getByText('Tags').parentElement, 'the tag bar row');
  await user.click(within(tags).getByRole('button', { name: 'forest (2 images)' }));
  expect(await within(dialog).findByText(/Showing 2 of 3 images/)).toBeInTheDocument();

  // Multiselect with the SAME gesture the store pane uses: click, then ctrl-click.
  const tiles = within(dialog).getAllByRole('button', { name: /^Select library image:/ });
  await user.click(must(tiles[0], 'the first library tile'));
  expect(within(dialog).getByText('1 selected')).toBeInTheDocument();
  fireEvent.click(must(tiles[1], 'the second library tile'), { ctrlKey: true });
  expect(within(dialog).getByText('2 selected')).toBeInTheDocument();

  await user.click(within(dialog).getByRole('button', { name: 'Add 2 to the store' }));

  await waitFor(() => {
    expect(store.names().filter((name) => name.startsWith('i-alice-'))).toHaveLength(4);
  });
  const progress = await within(dialog).findByLabelText('Push progress');
  await waitFor(() => {
    expect(within(progress).getAllByText(/stored as i-alice-/)).toHaveLength(2);
  });

  // The stored objects are WebP q90 at the SOURCE pixel dimensions, with the
  // row's OWN metadata carried across. (The library is newest-first, so the
  // first selected row is loc-2.)
  const first = storedHeader('i-alice-000003');
  expect(first.mimeType).toBe('image/webp');
  expect(first.quality).toBe(90);
  expect(first.width).toBe(640);
  expect(first.height).toBe(1024);
  expect(first.prompt).toBe('a local forest');
  expect(first.model).toBe('acme/art-1');
  expect(first.source).toBe('generated');
  expect(first.tags).toEqual(['forest']);
  expect(first.createdAt).toBe(new Date(1_700_000_001_000).toISOString());
  // THE SOURCE IDENTITY: sha256 of the ORIGINAL row bytes, NOT the WebP payload
  // (which the store's own re-encode changes) — the identity a later "already in
  // the store?" check can match.
  expect(first.sourceSha256).toBe(await sha256Hex(sourceBytes(640, 1024)));
  // `favorite` is DROPPED: a shared store has no per-device favourite, and the
  // header schema has no field for one.
  expect(Object.keys(first)).not.toContain('favorite');

  const second = storedHeader('i-alice-000004');
  expect(second.width).toBe(1600);
  expect(second.height).toBe(900);
  expect(second.prompt).toBe('a local orc');
  expect(second.tags).toEqual(['orc', 'forest']);
  expect(second.sourceSha256).toBe(await sha256Hex(sourceBytes(1600, 900)));

  // The index lists both, with their tags AND their source identity.
  const index = readIndex('alice');
  expect(index.images.map((image) => image.name)).toEqual([
    'i-alice-000001',
    'i-alice-000002',
    'i-alice-000003',
    'i-alice-000004',
  ]);
  expect(index.images.find((image) => image.name === 'i-alice-000003')?.tags).toEqual(['forest']);
  expect(index.images.find((image) => image.name === 'i-alice-000003')?.sourceSha256).toBe(
    await sha256Hex(sourceBytes(640, 1024)),
  );

  // THE ROUND TRIP: the store view re-reads its listing after the push, and the
  // gallery's OWN tag filter finds the pushed image by the tag it had locally.
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(await screen.findByText(/Showing 4 of 4 stored images/)).toBeInTheDocument();
  const storeTags = must(screen.getByText('Tags').parentElement, 'the store tag bar');
  await waitFor(() => {
    expect(within(storeTags).getByRole('button', { name: 'forest (3 images)' })).toBeInTheDocument();
  });
  await user.click(within(storeTags).getByRole('button', { name: 'forest (3 images)' }));
  expect(await screen.findByText(/Showing 3 of 4 stored images/)).toBeInTheDocument();
});

it('ONE refused object does not abort the batch, and a 429 keeps its Retry-After', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAliceFolder();
  await seedLocal([
    localRow({ id: 'loc-1', prompt: 'first push', model: 'acme/art-1', tags: [], width: 1000, height: 1000, createdAt: 1 }),
    localRow({ id: 'loc-2', prompt: 'second push', model: 'acme/art-1', tags: [], width: 1200, height: 800, createdAt: 2 }),
  ]);
  // The store refuses the first PICTURE once with its documented 429 envelope.
  store.failNextPut('i-alice-000003', {
    status: 429,
    code: 'rate_limited',
    message: 'slow down',
    retryAfterSeconds: 7,
  });
  render(<StoreArea />);
  const user = userEvent.setup();
  await screen.findByText(/Showing 2 of 2 stored images/);

  await user.click(screen.getByRole('button', { name: 'Add from gallery…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add images from your library' });
  await waitFor(() => {
    expect(within(dialog).getByText(/Showing 2 of 2 images/)).toBeInTheDocument();
  });
  await user.click(within(dialog).getByRole('button', { name: 'Select all' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add 2 to the store' }));

  const progress = await within(dialog).findByLabelText('Push progress');
  await waitFor(() => {
    expect(within(progress).getByText(/rate_limited/)).toBeInTheDocument();
  });
  // The refusal is stated WITH the service's Retry-After, and it is not retried
  // silently (the seam never retries a write).
  expect(within(progress).getByText(/wait 7s \(Retry-After\)/)).toBeInTheDocument();
  expect(within(progress).getByText(/first push/)).toBeInTheDocument();
  // The OTHER image still landed: exactly one new object, and the failed one
  // reports a row rather than vanishing.
  await waitFor(() => {
    expect(within(progress).getAllByText(/stored as i-alice-/)).toHaveLength(1);
  });
  expect(store.names().filter((name) => name.startsWith('i-alice-'))).toHaveLength(3);
  const index = readIndex('alice');
  expect(index.images).toHaveLength(3);
  expect(index.images.at(-1)?.name).toBe('i-alice-000003');
  expect(index.images.at(-1)?.tags).toEqual([]);
});

it('with NO key the picker shows the library and states why it cannot push, making no request', async () => {
  await seedSettings('');
  await seedLocal([
    localRow({ id: 'loc-1', prompt: 'untouchable', model: 'acme/art-1', tags: ['keeper'], width: 300, height: 200, createdAt: 5 }),
  ]);
  const fetchSpy = vi.fn(store.fetch);
  globalThis.fetch = fetchSpy;
  render(<StoreArea />);
  const user = userEvent.setup();

  await screen.findByText('No ServerStore key yet.');
  await user.click(screen.getByRole('button', { name: 'Add from gallery…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add images from your library' });

  // The LOCAL library is intact and readable — the store is what is missing.
  await waitFor(() => {
    expect(within(dialog).getByText(/Showing 1 of 1 images/)).toBeInTheDocument();
  });
  expect(within(dialog).getByText(/Pushing needs a ServerStore key/)).toBeInTheDocument();
  const push = within(dialog).getByRole('button', { name: 'Add to the store' });
  expect(push).toBeDisabled();
  // Nothing was asked of the service, and nothing was written anywhere.
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(store.objectCount()).toBe(0);
});

it('a shift-click selects the VISIBLE range of the library, in the pane\'s own order', async () => {
  await seedSettings('ssk_test_KEY');
  await seedAliceFolder();
  await seedLocal([
    localRow({ id: 'loc-1', prompt: 'one', model: 'm', tags: ['a'], width: 100, height: 100, createdAt: 1 }),
    localRow({ id: 'loc-2', prompt: 'two', model: 'm', tags: ['a'], width: 200, height: 200, createdAt: 2 }),
    localRow({ id: 'loc-3', prompt: 'three', model: 'm', tags: ['b'], width: 300, height: 300, createdAt: 3 }),
  ]);
  render(<StoreArea />);
  const user = userEvent.setup();
  await screen.findByText(/Showing 2 of 2 stored images/);

  await user.click(screen.getByRole('button', { name: 'Add from gallery…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add images from your library' });
  await waitFor(() => {
    expect(within(dialog).getByText(/Showing 3 of 3 images/)).toBeInTheDocument();
  });
  // Newest-first (the repo's ONE ordering seam): three, two, one.
  const tiles = within(dialog).getAllByRole('button', { name: /^Select library image:/ });
  expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([
    'Select library image: three',
    'Select library image: two',
    'Select library image: one',
  ]);
  await user.click(must(tiles[0], 'the first tile'));
  fireEvent.click(must(tiles[2], 'the third tile'), { shiftKey: true });
  expect(within(dialog).getByText('3 selected')).toBeInTheDocument();
});
