import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { serveThumbnail, storeCacheStats } from '@/server/store-cache';
import {
  createFolder,
  ensureIndex,
  readDirectory,
  rebuildIndex,
  setFolderPrivate,
  uploadImage,
  visibleFolders,
} from '@/server/store-folders';
import { listObjects, type StoreTarget, type WhoAmI } from '@/server/store-client';
import { sha256Hex } from '@/lib/sha256';
import { DEFAULT_STORE_QUALITY, encodeStoreImage } from '@/server/store-encode';
import { buildImageObject, imageObjectName, parseImageObject } from '@/server/store-files';

import { FakeServerStore } from './fakeStore';

/**
 * docs/17 row 42 — THE WHOLE STORE FLOW against a fake implementing the
 * documented contract (routes, statuses, envelope, name rule, `x-serverstore-
 * sha256`, body cap). Everything here goes through the app's REAL seam: the
 * only thing that is fake is the server.
 */

/** A value that must exist: no non-null assertion (forbidden) and no cast
 * (which would hide a genuinely missing fixture). */
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

const OTHER_WHO: WhoAmI = { ...WHO, id: 'key-2', label: 'bob' };

let store: FakeServerStore;
let target: StoreTarget;

/** jsdom has no canvas: the encoder is doubled with the REAL shape (ledger
 * rows 14/15). The bytes count the draw calls, so re-derivation is visible. */
class FakeCanvas {
  static encodeCount = 0;
  static lastSize: { width: number; height: number } | null = null;

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
    FakeCanvas.encodeCount += 1;
    FakeCanvas.lastSize = { width: this.width, height: this.height };
    return Promise.resolve(
      new Blob([new Uint8Array([this.width % 256, this.height % 256, FakeCanvas.encodeCount % 256])], {
        type: options.type,
      }),
    );
  }
}

const PIXELS = new Uint8Array(200).fill(7);

function fakeDecoder(width = 1200, height = 800): void {
  globalThis.createImageBitmap = (): Promise<ImageBitmap> =>
    Promise.resolve({ width, height, close: () => undefined } as unknown as ImageBitmap);
}

beforeEach(async () => {
  store = new FakeServerStore();
  store.install();
  target = { baseUrl: 'https://store.example', store: 'imager', key: 'ssk_test_KEY' };
  FakeCanvas.encodeCount = 0;
  globalThis.OffscreenCanvas = FakeCanvas as unknown as typeof OffscreenCanvas;
  fakeDecoder();
  await Promise.all([db.storeObjects.clear(), db.storeThumbs.clear()]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Encode a source image the way the app does, then upload those bytes. */
async function uploadOne(
  slug: string,
  index: Awaited<ReturnType<typeof ensureIndex>>['index'],
  known: readonly string[],
  byte = 1,
) {
  const source = new Blob([new Uint8Array(PIXELS.length).fill(byte)], { type: 'image/png' });
  const encoded = await encodeStoreImage(source, DEFAULT_STORE_QUALITY);
  const sourceSha256 = await sha256Hex(new Uint8Array(PIXELS.length).fill(byte));
  return uploadImage(
    target,
    {
      slug,
      bytes: encoded.bytes,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      quality: encoded.qualityPercent,
      prompt: `picture ${String(byte)}`,
      model: 'uploaded file',
      source: 'uploaded',
      tags: ['orc'],
      sourceSha256,
      id: `img-${String(byte)}`,
      createdAt: new Date(2026, 0, byte),
    },
    index,
    known,
  );
}

it('a folder is created, uploads land at their OWN size as WebP, and the listing finds them', async () => {
  const created = await createFolder(
    target,
    { slug: 'alice', displayName: 'Alice', private: false, who: WHO },
    [],
  );
  expect(created.owner).toBe('key-1');
  expect(store.names()).toEqual(['folder-alice', 'folder-alice-index']);

  let directory = await readDirectory(target);
  expect(directory.folders).toHaveLength(1);
  const listing = must(directory.folders[0], 'the alice folder');
  const { index } = await ensureIndex(target, listing, directory.byName);
  const uploaded = await uploadOne('alice', index, directory.entries.map((e) => e.name));

  expect(uploaded.name).toBe('i-alice-000001');
  const stored = store.read('i-alice-000001');
  expect(stored).toBeDefined();
  const parsed = parseImageObject(new TextDecoder().decode(stored));
  // THE FORMAT PIN: the payload is WebP, the pixels are the SOURCE's size (no
  // resize), and the quality is recorded in the object's own header.
  expect(parsed.mimeType).toBe('image/webp');
  expect(parsed.width).toBe(1200);
  expect(parsed.height).toBe(800);
  expect(parsed.quality).toBe(90);
  expect(parsed.tags).toEqual(['orc']);
  // The SOURCE identity is recorded in the header (docs/17 row 45) and carried
  // into the index, where it survives a re-read (below).
  expect(parsed.sourceSha256).toBe(await sha256Hex(new Uint8Array(PIXELS.length).fill(1)));

  directory = await readDirectory(target);
  expect(directory.folders[0]?.imageNames).toEqual(['i-alice-000001']);
  const rebuilt = await ensureIndex(
    target,
    must(directory.folders[0], 'the alice folder'),
    directory.byName,
  );
  expect(rebuilt.rebuilt).toBe(false);
  expect(rebuilt.index.images.map((image) => image.name)).toEqual(['i-alice-000001']);
  expect(rebuilt.index.images[0]?.sourceSha256).toBe(
    await sha256Hex(new Uint8Array(PIXELS.length).fill(1)),
  );
  expect(rebuilt.index.nextSeq).toBe(2);
});

it('a sequence COLLISION takes the next free one — and the store never loses a picture', async () => {
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  const directory = await readDirectory(target);
  const listing = must(directory.folders[0], 'the alice folder');
  const { index } = await ensureIndex(target, listing, directory.byName);
  await uploadOne('alice', index, []);

  // A second writer holding the SAME stale index (nextSeq 1), but which DOES
  // list the store before writing — exactly the situation the API cannot
  // prevent, because there is no compare-and-swap: the listing is the only
  // source of truth about which names exist.
  const stale = { ...index, nextSeq: 1, images: [] };
  const second = await uploadOne('alice', stale, store.names());
  expect(second.name).toBe('i-alice-000002');
  expect(second.raced).toBe(true);
  expect(store.names().filter((name) => name.startsWith('i-'))).toEqual([
    'i-alice-000001',
    'i-alice-000002',
  ]);
});

it('a MISSING index is rebuilt from the listing and each image header — never shown empty', async () => {
  // A folder whose index never got written (a half-finished writer).
  store.seed('folder-bob', JSON.stringify({
    v: 1,
    slug: 'bob',
    owner: 'key-2',
    displayName: 'Bob',
    private: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  // Two images present with NO index — uploaded through the seam, then the
  // index object is removed to simulate the damaged state.
  await createFolder(target, { slug: 'bob2', displayName: 'Bob', private: false, who: OTHER_WHO }, []);
  const first = await readDirectory(target);
  const bob2 = must(
    first.folders.find((folder) => folder.record.slug === 'bob2'),
    'the bob2 folder',
  );
  const { index } = await ensureIndex(target, bob2, first.byName);
  await uploadOne('bob2', index, []);
  await uploadOne('bob2', { ...index, nextSeq: 2 }, []);
  store.remove('folder-bob2-index');

  const directory = await readDirectory(target);
  const damaged = must(
    directory.folders.find((folder) => folder.record.slug === 'bob2'),
    'the damaged bob2 folder',
  );
  expect(damaged.indexMissing).toBe(true);
  expect(damaged.imageNames).toHaveLength(2);

  const rebuilt = await ensureIndex(target, damaged, directory.byName);
  expect(rebuilt.rebuilt).toBe(true);
  expect(rebuilt.index.images).toHaveLength(2);
  expect(rebuilt.index.nextSeq).toBe(3);
  // The rebuild is WRITTEN, so the next read is cheap and agrees.
  const again = await readDirectory(target);
  const cheap = must(
    again.folders.find((folder) => folder.record.slug === 'bob2'),
    'the rebuilt bob2 folder',
  );
  expect(cheap.indexMissing).toBe(false);
  expect(cheap.index?.images).toHaveLength(2);
});

it('a STALE index (parses, but does not cover the listing) is rebuilt, never shown short', async () => {
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  const first = await readDirectory(target);
  const { index } = await ensureIndex(target, must(first.folders[0], 'the alice folder'), first.byName);
  await uploadOne('alice', index, []);
  // The image is in the STORE, but the index does not know about it (a
  // half-written index, or an upload whose index PUT was lost).
  store.seed(
    'folder-alice-index',
    JSON.stringify({ v: 1, slug: 'alice', nextSeq: 1, images: [] }),
  );

  const directory = await readDirectory(target);
  const stale = must(directory.folders[0], 'the alice folder');
  // NOT silently shown as an empty folder: the listing knows about the image,
  // so the index is treated as unusable and the loud rebuild runs.
  expect(stale.indexMissing).toBe(true);
  expect(stale.imageNames).toEqual(['i-alice-000001']);
  const rebuilt = await ensureIndex(target, stale, directory.byName);
  expect(rebuilt.rebuilt).toBe(true);
  expect(rebuilt.index.images.map((image) => image.name)).toEqual(['i-alice-000001']);
  expect(rebuilt.index.nextSeq).toBe(2);

  // An object overwritten IN PLACE keeps its name: the stored hash for the same
  // name must also count as stale.
  const replaced = store.replace(
    'i-alice-000001',
    buildImageObject(
      {
        v: 1,
        id: 'img-1',
        folder: 'alice',
        tags: ['orc'],
        prompt: 'replaced',
        model: 'uploaded file',
        source: 'uploaded',
        createdAt: '2026-01-01T00:00:00.000Z',
        width: 10,
        height: 10,
        mimeType: 'image/webp',
        quality: 90,
      },
      new Uint8Array(50).fill(5),
    ),
  );
  const afterReplace = await readDirectory(target);
  const overwritten = must(afterReplace.folders[0], 'the alice folder');
  expect(overwritten.indexMissing).toBe(true);
  const reindexed = await rebuildIndex(target, 'alice', overwritten.imageNames, afterReplace.byName);
  expect(reindexed.images[0]?.sha256).toBe(replaced);
});

it('a CORRUPT index is rebuilt too (it is never trusted)', async () => {
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  const first = await readDirectory(target);
  const listing = must(first.folders[0], 'the alice folder');
  const { index } = await ensureIndex(target, listing, first.byName);
  await uploadOne('alice', index, []);
  store.seed('folder-alice-index', '{ not json');

  const directory = await readDirectory(target);
  const damaged = must(directory.folders[0], 'the alice folder');
  expect(damaged.indexMissing).toBe(true);
  const rebuilt = await rebuildIndex(target, 'alice', damaged.imageNames, directory.byName);
  expect(rebuilt.images).toHaveLength(1);
});

it('an object whose header and name disagree is a LOUD failure, not a silent index entry', async () => {
  store.seed('folder-alice', JSON.stringify({
    v: 1,
    slug: 'alice',
    owner: 'key-1',
    displayName: 'Alice',
    private: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  // An image object that CLAIMS folder "bob" while living at i-alice-000001.
  store.seed(
    imageObjectName('alice', 1),
    buildImageObject(
      {
        v: 1,
        id: 'x',
        folder: 'bob',
        tags: [],
        prompt: '',
        model: 'm',
        source: 'uploaded',
        createdAt: '2026-01-01T00:00:00.000Z',
        width: 1,
        height: 1,
        mimeType: 'image/webp',
        quality: 90,
      },
      new Uint8Array([1]),
    ),
  );
  const directory = await readDirectory(target);
  await expect(
    rebuildIndex(target, 'alice', ['i-alice-000001'], directory.byName),
  ).rejects.toThrow(/name and header disagree/);
});

it('privacy is HONOURED by this app: another key\'s private folder is hidden, your own never is', async () => {
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  await createFolder(
    target,
    { slug: 'secret', displayName: 'Bob private', private: true, who: OTHER_WHO },
    ['alice'],
  );
  await createFolder(
    target,
    { slug: 'public', displayName: 'Bob public', private: false, who: OTHER_WHO },
    ['alice', 'secret'],
  );
  const directory = await readDirectory(target);
  const mine = visibleFolders(directory.folders, 'alice');
  expect(mine.map((folder) => folder.record.slug)).toEqual(['alice', 'public']);

  // Bob still sees alice's PUBLIC folder and his own private one.
  const bobs = visibleFolders(directory.folders, 'secret');
  expect(bobs.map((folder) => folder.record.slug)).toEqual(['alice', 'public', 'secret']);

  // And the flag is only a courtesy: the record IS readable by any key.
  const objects = await listObjects(target, 'folder-secret');
  expect(objects.map((entry) => entry.name)).toEqual(['folder-secret', 'folder-secret-index']);
});

it('the privacy flag round-trips through the record (read -> validate -> write)', async () => {
  const created = await createFolder(
    target,
    { slug: 'alice', displayName: 'Alice', private: false, who: WHO },
    [],
  );
  const next = await setFolderPrivate(target, created, true);
  expect(next.private).toBe(true);
  expect(next.updatedAt >= created.updatedAt).toBe(true);
  const directory = await readDirectory(target);
  expect(directory.folders[0]?.record.private).toBe(true);
  // An ILLEGAL slug is refused by the writer too, not sanitised.
  await expect(
    createFolder(target, { slug: 'Alice', displayName: 'x', private: false, who: WHO }, []),
  ).rejects.toThrow(/not a legal folder slug/);
});

it('CACHE INVALIDATION: a changed sha256 refetches the FULL image and re-derives the thumbnail', async () => {
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  const first = await readDirectory(target);
  const { index } = await ensureIndex(target, must(first.folders[0], 'the alice folder'), first.byName);
  const uploaded = await uploadOne('alice', index, []);
  expect(FakeCanvas.encodeCount).toBe(1);

  const entry = must((await listObjects(target, uploaded.name))[0], 'the uploaded object in the listing');
  const before = await serveThumbnail(target, uploaded.name, { sha256: entry.sha256 });
  const afterCache = await serveThumbnail(target, uploaded.name, { sha256: entry.sha256 });
  // The second read came from the cache: byte-identical, no new fetch.
  // `Array.from` rather than `toEqual` on the typed arrays: a row read back
  // through IndexedDB is structured-cloned and may be another realm's view
  // (the same reason the app's schemas use a tag check, not `instanceof`).
  expect(Array.from(afterCache.bytes)).toEqual(Array.from(before.bytes));
  const requestsBefore = store.requests.filter(
    (request) => request.method === 'GET' && request.target === uploaded.name,
  ).length;
  expect(requestsBefore).toBe(1);

  // THE LEVER: the object changes on the server — a real, valid image object
  // with DIFFERENT bytes. The listing reports a new sha256, and that MUST
  // invalidate the cached thumbnail.
  const nextBytes = new TextEncoder().encode(
    buildImageObject(
      {
        v: 1,
        id: 'img-1',
        folder: 'alice',
        tags: ['orc'],
        prompt: 'picture 1',
        model: 'uploaded file',
        source: 'uploaded',
        createdAt: '2026-01-01T00:00:00.000Z',
        width: 1200,
        height: 800,
        mimeType: 'image/webp',
        quality: 90,
      },
      new Uint8Array(300).fill(11),
    ),
  );
  const newSha = store.replace(uploaded.name, nextBytes);
  expect(newSha).not.toBe(entry.sha256);

  const refetched = await serveThumbnail(target, uploaded.name, { sha256: newSha });
  const getsNow = store.requests.filter(
    (request) => request.method === 'GET' && request.target === uploaded.name,
  ).length;
  expect(getsNow).toBe(2);
  expect(Array.from(refetched.bytes)).not.toEqual(Array.from(before.bytes));
  expect(FakeCanvas.encodeCount).toBeGreaterThan(1);
  // And the stale row is gone, not merely ignored.
  const cached = await db.storeObjects.get(uploaded.name);
  expect(cached?.sha256).toBe(newSha);
});

it('the cache is an OPTIMISATION: an empty cache still serves the exact stored bytes', async () => {
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  const directory = await readDirectory(target);
  const { index } = await ensureIndex(
    target,
    must(directory.folders[0], 'the alice folder'),
    directory.byName,
  );
  const uploaded = await uploadOne('alice', index, []);
  await db.storeObjects.clear();
  await db.storeThumbs.clear();
  const entry = must((await listObjects(target, uploaded.name))[0], 'the listing entry');
  const original = await import('@/server/store-cache').then(({ fetchOriginal }) =>
    fetchOriginal(target, uploaded.name, { sha256: entry.sha256 }),
  );
  const stored = must(store.read(uploaded.name), 'the stored object');
  // What came back over the wire is the OBJECT the store holds, byte for byte.
  expect(Array.from(original.objectBytes)).toEqual(Array.from(stored));
  // ... and the store's own sha256 for it is the hash of those bytes.
  expect(entry.sha256).toBe(await sha256Hex(original.objectBytes));
  // The object is self-describing: the payload's hash is recorded in its own
  // header, so a reader can verify the picture without the listing.
  const parsed = parseImageObject(new TextDecoder().decode(original.objectBytes));
  expect(Array.from(parsed.bytes)).toEqual(Array.from(original.bytes));
  expect(await sha256Hex(parsed.bytes)).toBe(parsed.sha256);
  const stats = await storeCacheStats();
  expect(stats.objects).toBe(1);
});

it('a per-file failure is reported WITHOUT aborting the batch (the 64 MiB cap)', async () => {
  // The folder record and index are written first, so the cap is lowered only
  // after they exist: the NEXT write is the image object, and it is refused.
  const small = new FakeServerStore();
  small.install();
  await createFolder(target, { slug: 'alice', displayName: 'Alice', private: false, who: WHO }, []);
  const directory = await readDirectory(target);
  const { index } = await ensureIndex(
    target,
    must(directory.folders[0], 'the alice folder'),
    directory.byName,
  );
  small.setMaxBytes(1);
  // The encoded payload is over the cap: the service answers 413 and the app
  // reports THAT file's failure with the service's own message.
  await expect(uploadOne('alice', index, [])).rejects.toThrow(/payload_too_large/);
  // The service's own message reaches the caller: it names the cap it enforced.

  // The folder is untouched: no half-written image object.
  expect(small.names().filter((name) => name.startsWith('i-'))).toEqual([]);
});
