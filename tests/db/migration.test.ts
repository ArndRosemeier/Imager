import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';

import { ImagerDb, SETTINGS_ID, db } from '@/db/db';
import { getImage, saveUploadedImage } from '@/db/imageRepo';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the v1 settings row survives the v5 bump (images + runs + conversations)', async () => {
  const name = 'imager-migration-test';
  const v1 = new Dexie(name);
  v1.version(1).stores({ settings: 'id' });
  const row = { id: SETTINGS_ID, openRouterApiKey: 'sk-1', imageModel: 'a/b', refineChatModel: '' };
  await v1.table('settings').put(row);
  v1.close();

  const v5 = new ImagerDb(name);
  await expect(v5.settings.get(SETTINGS_ID)).resolves.toEqual(row);
  expect(v5.verno).toBe(5);
  await expect(v5.images.count()).resolves.toBe(0);
  await expect(v5.runs.count()).resolves.toBe(0);
  await expect(v5.conversations.count()).resolves.toBe(0);
  v5.close();
});

/**
 * The v5 bump adds `StoredImage.favorite`. Rows were written by v1 (settings),
 * v3 (images/runs) and v4 (conversations), and only the EXISTING `images` index
 * set is redeclared, so the pin is that nothing moves: every row reads back at
 * v5 with its own meaning — the v3 image WITHOUT a `favorite` key.
 */
it('v1, v3 and v4 rows survive the v5 favourites bump untouched', async () => {
  const name = 'imager-migration-test-v5';
  const v1 = new Dexie(name);
  v1.version(1).stores({ settings: 'id' });
  const row = { id: SETTINGS_ID, openRouterApiKey: 'sk-1', imageModel: 'a/b', refineChatModel: '' };
  await v1.table('settings').put(row);
  v1.close();

  const v4 = new Dexie(name);
  v4.version(1).stores({ settings: 'id' });
  v4.version(2).stores({ images: 'id, createdAt, runId', runs: 'id, createdAt' });
  v4.version(3).stores({ images: 'id, createdAt, runId', runs: 'id, createdAt' });
  v4.version(4).stores({ conversations: 'id, updatedAt' });
  await v4.table('images').put({
    id: 'img-1',
    bytes: new Uint8Array([9, 9]),
    mimeType: 'image/png',
    width: 2,
    height: 2,
    prompt: 'v3 image',
    model: 'a/b',
    source: 'generated',
    createdAt: 7,
    runId: 'run-1',
  });
  await v4.table('runs').put({
    id: 'run-1',
    kind: 'refine',
    prompt: 'v3 run',
    model: 'a/b',
    inputImageIds: ['img-0'],
    requestedCount: 1,
    receivedCount: 1,
    filteredCount: 0,
    costUsd: 0.5,
    createdAt: 7,
    error: null,
  });
  await v4.table('conversations').put({
    id: 'conv-1',
    title: 'v4 conversation',
    model: 'a/b',
    createdAt: 8,
    updatedAt: 9,
    messages: [],
  });
  v4.close();

  const v5 = new ImagerDb(name);
  expect(v5.verno).toBe(5);
  await expect(v5.settings.get(SETTINGS_ID)).resolves.toEqual(row);
  const image = await v5.images.get('img-1');
  expect(image).toMatchObject({ prompt: 'v3 image', source: 'generated', runId: 'run-1' });
  // The stored row was NOT rewritten by the bump: it still has no favourite key
  // (the READING path supplies the pre-field meaning — the next test).
  expect(image).not.toHaveProperty('favorite');
  expect([...(image?.bytes ?? [])]).toEqual([9, 9]);
  const run = await v5.runs.get('run-1');
  expect(run).toMatchObject({ kind: 'refine', inputImageIds: ['img-0'], costUsd: 0.5 });
  await expect(v5.conversations.get('conv-1')).resolves.toMatchObject({ title: 'v4 conversation' });
  v5.close();
});

/**
 * The v5 CONTENT change adds `StoredImage.favorite`. Rows a pre-favourites app
 * wrote have no such key, so the READING path is what must keep working —
 * proven on the APP's own database (the same `db` the repositories use) by
 * writing a pre-field row, reading it through the repo and writing it back.
 */
it('a row written WITHOUT favorite reads as false and round-trips', async () => {
  await db.images.clear();
  await db.images.put({
    id: 'img-legacy',
    bytes: new Uint8Array([4, 5, 6]),
    mimeType: 'image/png',
    width: 3,
    height: 3,
    prompt: 'written before favourites',
    model: 'a/b',
    source: 'generated',
    createdAt: 3,
    runId: '',
  } as never);

  const read = await getImage('img-legacy');
  expect(read?.favorite).toBe(false);
  expect(read?.prompt).toBe('written before favourites');
  expect([...(read?.bytes ?? [])]).toEqual([4, 5, 6]);

  // Round trip: the read row (now carrying the default) writes back and reads
  // identically — nothing is fabricated and nothing is lost.
  if (read === undefined) throw new Error('seed failed');
  await db.images.put(read);
  const again = await getImage('img-legacy');
  expect(again).toEqual(read);
  await db.images.clear();
});

/**
 * The v3 content change adds `StoredImage.source` and `Run.kind` /
 * `Run.inputImageIds`. Rows a v2 app wrote have none of them, so the READING
 * path is what must keep working — proven on the APP's own database (the same
 * `db` the repositories use) by writing v2-shaped rows and reading them back
 * through the repo.
 */
it('v2 images/runs rows survive the v3 content change and read as their old meaning', async () => {
  await Promise.all([db.images.clear(), db.runs.clear()]);
  await db.images.put({
    id: 'img-1',
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: 'old image',
    model: 'a/b',
    createdAt: 1,
    runId: 'run-1',
  } as never);
  await db.runs.put({
    id: 'run-1',
    prompt: 'old run',
    model: 'a/b',
    requestedCount: 1,
    receivedCount: 1,
    filteredCount: 0,
    costUsd: null,
    createdAt: 1,
    error: null,
  } as never);

  const { getRun } = await import('@/db/imageRepo');
  const image = await getImage('img-1');
  expect(image?.prompt).toBe('old image');
  expect(image?.source).toBe('generated');
  expect([...(image?.bytes ?? [])]).toEqual([1, 2, 3]);
  const run = await getRun('run-1');
  expect(run?.kind).toBe('generate');
  expect(run?.inputImageIds).toEqual([]);
  expect(run?.prompt).toBe('old run');
  await Promise.all([db.images.clear(), db.runs.clear()]);
});

it('an upload has no run: the empty runId round-trips, nothing is fabricated', async () => {
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 4, height: 4, close: () => undefined }),
  );
  await db.images.clear();
  const stored = await saveUploadedImage({
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    fileName: 'a.png',
  });
  const read = await getImage(stored.id);
  expect(read?.runId).toBe('');
  expect(read?.source).toBe('uploaded');
  await db.images.clear();
});
