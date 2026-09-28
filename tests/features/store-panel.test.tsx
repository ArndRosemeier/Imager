import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { DEFAULT_SETTINGS } from '@/domain/settings';
import { StoreArea } from '@/features/store/StoreArea';
import { sha256Hex } from '@/lib/sha256';
import { DEFAULT_STORE_QUALITY, encodeStoreImage } from '@/server/store-encode';
import { parseImageObject } from '@/server/store-files';
import { createFolder, ensureIndex, uploadImage } from '@/server/store-folders';
import { readDirectory, type FolderListing } from '@/server/store-folders';

export type { FolderListing };
import type { StoreTarget, WhoAmI } from '@/server/store-client';

import { FakeServerStore } from '../server/fakeStore';

/**
 * docs/17 row 42 — THE STORE TAB AND THE FOLDER DIALOG, driven through the real
 * components against a fake of the documented ServerStore contract.
 *
 * The pins: no key leaves every OTHER feature working and the store surfaces
 * explaining themselves; connect shows YOUR folder and the public ones while a
 * private folder of another identity is hidden; the tag bar filters the STORE
 * images with the same seam as the gallery; multiselect downloads one ZIP of
 * the exact bytes; uploads are WebP at the source's pixel size with per-file
 * errors that do not abort the batch.
 */

/** A value that must exist, without a non-null assertion (forbidden here) or a
 * cast (which would hide a genuinely missing element). */
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
const OTHER: WhoAmI = { ...WHO, id: 'key-2', label: 'bob' };

let store: FakeServerStore;

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
    // A payload that identifies the drawn size, so "which image is this" is
    // assertable from the bytes alone.
    return Promise.resolve(
      new Blob([new Uint8Array([this.width % 256, this.height % 256, 42])], { type: options.type }),
    );
  }
}

function target(): StoreTarget {
  return { baseUrl: 'https://store.example', store: 'imager', key: 'ssk_test_KEY' };
}

/** Upload one image through the REAL seam, so the fixture is the app's own. */
async function seedImage(slug: string, listing: FolderListing, position: number): Promise<string> {
  const directory = await readDirectory(target());
  const { index } = await ensureIndex(
    target(),
    directory.folders.find((folder) => folder.record.slug === slug) ?? listing,
    directory.byName,
  );
  const encoded = await encodeStoreImage(
    new Blob([new Uint8Array(64).fill(position)], { type: 'image/png' }),
    DEFAULT_STORE_QUALITY,
  );
  const sourceSha256 = await sha256Hex(new Uint8Array(64).fill(position));
  const uploaded = await uploadImage(
    target(),
    {
      slug,
      bytes: encoded.bytes,
      mimeType: encoded.mimeType,
      width: 1200,
      height: 900,
      quality: encoded.qualityPercent,
      prompt: `seeded ${String(position)}`,
      model: 'uploaded file',
      source: 'uploaded',
      tags: position === 1 ? ['orc', 'forest'] : ['orc'],
      sourceSha256,
      id: `seed-${String(position)}`,
      createdAt: new Date(2026, 0, position),
    },
    index,
    directory.entries.map((entry) => entry.name),
  );
  return uploaded.name;
}

async function seedFolders(): Promise<void> {
  await createFolder(target(), { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  await createFolder(
    target(),
    { slug: 'bob', displayName: 'Bob public', private: false, who: OTHER },
    ['alice'],
  );
  await createFolder(
    target(),
    { slug: 'secret', displayName: 'Bob private', private: true, who: OTHER },
    ['alice', 'bob'],
  );
  const directory = await readDirectory(target());
  const alice = must(
    directory.folders.find((folder) => folder.record.slug === 'alice'),
    'the alice folder',
  );
  await seedImage('alice', alice, 1);
  await seedImage('alice', alice, 2);
  const bob = must(
    directory.folders.find((folder) => folder.record.slug === 'bob'),
    'the bob folder',
  );
  await seedImage('bob', bob, 3);
  const secret = must(
    directory.folders.find((folder) => folder.record.slug === 'secret'),
    'the secret folder',
  );
  await seedImage('secret', secret, 4);
  // The store legitimately holds objects this app did not write.
  store.seed('notes.txt', 'someone else was here');
}

async function seedSettings(serverStoreKey: string): Promise<void> {
  await db.settings.put({
    ...DEFAULT_SETTINGS,
    id: 'settings',
    serverStoreKey,
    serverStoreFolder: 'alice',
  });
}

beforeEach(async () => {
  store = new FakeServerStore();
  store.install();
  globalThis.OffscreenCanvas = FakeCanvas as unknown as typeof OffscreenCanvas;
  // The decoder double mirrors the REAL contract: a corrupt source REJECTS
  // (jsdom has no image codec, so a blob of 3 bytes is the honest stand-in for
  // "this file is not a decodable picture").
  const decode = (blob: Blob): Promise<ImageBitmap> =>
    blob.size === 3
      ? Promise.reject(new Error('The source image could not be decoded'))
      : Promise.resolve({
          width: 1200,
          height: 900,
          close: () => undefined,
        } as unknown as ImageBitmap);
  globalThis.createImageBitmap = decode as unknown as typeof createImageBitmap;
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

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

it('with NO key: the store explains itself, makes no request, and every other tab still works', async () => {
  await seedSettings('');
  const fetchSpy = vi.fn(store.fetch);
  globalThis.fetch = fetchSpy;
  render(<App initialTab="Store" />);

  expect(await screen.findByText('No ServerStore key yet.')).toBeInTheDocument();
  expect(
    screen.getByText(/Until then every other part of Imager works exactly as before/),
  ).toBeInTheDocument();
  // Nothing was asked of the service: an unconfigured app does not probe.
  expect(fetchSpy).not.toHaveBeenCalled();

  // The rest of the app is untouched. The gallery tab renders its own honest
  // empty state, and the Generate tab its form — no store needed.
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));
  expect(await screen.findByText('No images yet.')).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Generate' }));
  expect(await screen.findByRole('tab', { name: 'Create' })).toBeInTheDocument();
});

it('connect proves the key with /whoami, and the folder dialog opens on YOUR folder', async () => {
  await seedSettings('');
  await seedFolders();
  render(<StoreArea />);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Access key'), 'ssk_test_KEY');
  await user.click(screen.getByRole('button', { name: 'Connect' }));

  // The identity is shown, from the service, not guessed.
  expect(await screen.findByText(/ServerStore · alice/)).toBeInTheDocument();
  expect(store.requests.some((request) => request.target === '/whoami')).toBe(true);
  // YOUR folder and the other PUBLIC one are listed; the other key's PRIVATE
  // folder is hidden (honour-based, and the copy says so).
  const folders = await screen.findByRole('navigation', { name: 'Store folders' });
  expect(within(folders).getByText('Alice')).toBeInTheDocument();
  // HIDDEN: the other key's private folder (honour-based; the copy says so).
  expect(within(folders).queryByText('Bob private')).not.toBeInTheDocument();
  expect(screen.getByText(/courtesy between users of Imager, not a lock/)).toBeInTheDocument();
  // A folder that is not ours is hidden until the scope switch is used.
  expect(within(folders).getByText('Bob public')).toBeInTheDocument();
});

it('the tag bar filters the STORE images through the gallery\'s own seam, and multiselect counts', async () => {
  await seedSettings('ssk_test_KEY');
  await seedFolders();
  render(<StoreArea />);
  const user = userEvent.setup();

  expect(await screen.findByText(/Showing 2 of 2 stored images/)).toBeInTheDocument();
  // The derived bar carries the counts of the images on screen (2 orc, 1 forest).
  const tags = must(screen.getByText('Tags').parentElement, 'the tag bar row');
  expect(within(tags).getByRole('button', { name: 'orc (2 images)' })).toBeInTheDocument();
  expect(within(tags).getByRole('button', { name: 'forest (1 image)' })).toBeInTheDocument();
  await user.click(within(tags).getByRole('button', { name: 'forest (1 image)' }));
  expect(await screen.findByText(/Showing 1 of 2 stored images/)).toBeInTheDocument();

  // Clear, then multiselect: one click, one ctrl-click.
  await user.click(screen.getByRole('button', { name: 'Clear tags' }));
  const tiles = await screen.findAllByRole('button', { name: /^Select stored image/ });
  expect(tiles).toHaveLength(2);
  await user.click(must(tiles[0], 'the first tile'));
  expect(screen.getByText('1 selected')).toBeInTheDocument();
  fireEvent.click(must(tiles[1], 'the second tile'), { ctrlKey: true });
  expect(screen.getByText('2 selected')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Download 2 selected as one ZIP' }),
  ).toBeInTheDocument();
});

it('downloading a multiselection saves ONE zip of the exact bytes the store served', async () => {
  await seedSettings('ssk_test_KEY');
  await seedFolders();
  const blobs: Blob[] = [];
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: (options: { suggestedName: string }) => {
      blobs.push(new Blob([options.suggestedName]));
      return Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: (data: Blob) => {
              blobs.push(data);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
      } as unknown as FileSystemFileHandle);
    },
  });
  render(<StoreArea />);
  const user = userEvent.setup();

  await screen.findByText(/Showing 2 of 2 stored images/);
  await user.click(screen.getByRole('button', { name: 'Select all' }));
  await user.click(screen.getByRole('button', { name: 'Download 2 selected as one ZIP' }));

  await waitFor(() => {
    expect(blobs.filter((blob) => blob.type === 'application/zip')).toHaveLength(1);
  });
  const archive = must(blobs.find((blob) => blob.type === 'application/zip'), 'the zip blob');
  // The suggested name is on the picker's first recorded blob.
  const suggested = await blobs[0]?.text();
  expect(suggested).toMatch(/^imager-store-.*\.zip$/);

  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const names = Object.keys(entries).sort();
  // The extension comes from the picture's own MIME type, via the folder index.
  expect(names).toEqual(['001-i-alice-000001.webp', '002-i-alice-000002.webp']);
  const stored = must(store.read('i-alice-000001'), 'the stored object');
  const object = parseImageObject(new TextDecoder().decode(stored));
  expect(object.mimeType).toBe('image/webp');
  // The archive entry IS the picture — the payload inside the stored object,
  // byte for byte. The object's JSON envelope is not what a download delivers.
  const firstEntry = must(entries[names[0] ?? ''], 'the first archive entry');
  expect(Array.from(firstEntry)).toEqual(Array.from(object.bytes));
});

it('an upload PUTs WebP at the source pixel size, keeps the tags, and reports each file', async () => {
  await seedSettings('ssk_test_KEY');
  await seedFolders();
  const { container } = render(<StoreArea />);
  const user = userEvent.setup();
  await screen.findByText(/Showing 2 of 2 stored images/);

  // Filter to `forest`, so the uploaded file inherits that tag (the tag bar is
  // the filter AND the tagging control for an upload).
  const tags = must(screen.getByText('Tags').parentElement, 'the tag bar row');
  await user.click(within(tags).getByRole('button', { name: 'forest (1 image)' }));

  // The generic parameter narrows the query WITHOUT a cast: `querySelector`
  // returns `Element | null`, and the upload control is an input.
  const input = must(
    container.querySelector<HTMLInputElement>('input[type="file"]'),
    'the upload input',
  );
  const file = new File([new Uint8Array(128).fill(9)], 'photo.png', { type: 'image/png' });
  await user.upload(input, file);

  /*
   * The DURABLE per-file surface, not the toast: the progress list is what
   * stays on screen and what the owner reads file by file. (The app's ONE
   * toast surface is pinned in tests/features/save-all.test.tsx and
   * tests/features/tags.test.tsx.)
   */
  const row = await screen.findByLabelText('Upload progress');
  await waitFor(() => {
    expect(within(row).getByText(/stored as i-alice-000003/)).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(store.names().filter((name) => name.startsWith('i-alice-'))).toHaveLength(3);
  });
  const put = store.requests.find(
    (request) => request.method === 'PUT' && request.target === 'i-alice-000003',
  );
  expect(put?.status).toBe(201);
  const storedText = new TextDecoder().decode(store.read('i-alice-000003'));
  // The stored object says WebP at quality 90 and the SOURCE's pixel size.
  expect(storedText).toContain('"mimeType": "image/webp"');
  expect(storedText).toContain('"quality": 90');
  expect(storedText).toContain('"width": 1200');
  expect(storedText).toContain('"height": 900');
  expect(storedText).toContain('"tags": [');
  expect(storedText).toContain('"forest"');
  expect(storedText).toContain('"prompt": "photo.png"');
  // The SAME uploader records the SOURCE identity for the device path too
  // (docs/17 row 45): the sha256 of the file's ORIGINAL bytes, not the WebP
  // payload the store now holds.
  const object = parseImageObject(storedText);
  expect(object.sourceSha256).toBe(await sha256Hex(new Uint8Array(128).fill(9)));
});

it('one bad file is a failed ROW; the good file in the same batch still lands', async () => {
  await seedSettings('ssk_test_KEY');
  await seedFolders();
  const { container } = render(<StoreArea />);
  const user = userEvent.setup();
  await screen.findByText(/Showing 2 of 2 stored images/);

  // BOTH files are images as far as the picker's `accept` is concerned, and the
  // FIRST one is a corrupt PNG the decoder refuses — the realistic per-file
  // failure, and the one `accept="image/*"` cannot filter out.
  const broken = new File([new Uint8Array([1, 2, 3])], 'broken.png', { type: 'image/png' });
  const good = new File([new Uint8Array(64).fill(3)], 'good.png', { type: 'image/png' });
  // The generic parameter narrows the query WITHOUT a cast: `querySelector`
  // returns `Element | null`, and the upload control is an input.
  const input = must(
    container.querySelector<HTMLInputElement>('input[type="file"]'),
    'the upload input',
  );
  await user.upload(input, [broken, good]);

  const row = await screen.findByLabelText('Upload progress');
  await waitFor(() => {
    // ONE failed row, with its own reason, and the batch continued.
    expect(within(row).getByText(/could not be decoded/)).toBeInTheDocument();
  });
  expect(within(row).getByText(/broken\.png/)).toBeInTheDocument();
  expect(within(row).getByText(/good\.png/)).toBeInTheDocument();
  // The good one really reached the store, in the same batch.
  expect(store.names()).toContain('i-alice-000003');
});

it('a folder with NO readable index is rebuilt from the listing instead of looking empty', async () => {
  await seedSettings('ssk_test_KEY');
  await seedFolders();
  store.remove('folder-alice-index');
  render(<StoreArea />);

  // The rebuild is the app's own loud path: the index object comes back, built
  // from the listing and each image's header.
  await waitFor(() => {
    expect(store.names()).toContain('folder-alice-index');
  });
  await waitFor(() => {
    expect(screen.getByText(/Showing 2 of 2 stored images/)).toBeInTheDocument();
  });
});

it('a folder record this app cannot read is NOT presented as a folder', async () => {
  await seedSettings('ssk_test_KEY');
  await seedFolders();
  store.seed('folder-broken', '{ not json at all');
  render(<StoreArea />);
  const folders = await screen.findByRole('navigation', { name: 'Store folders' });
  expect(within(folders).queryByText('broken')).not.toBeInTheDocument();
});
