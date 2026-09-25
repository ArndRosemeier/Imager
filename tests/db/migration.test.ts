import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';

import { ImagerDb, SETTINGS_ID, db } from '@/db/db';
import { getImage, saveUploadedImage } from '@/db/imageRepo';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the v1 settings row survives the v4 bump (images + runs + conversations)', async () => {
  const name = 'imager-migration-test';
  const v1 = new Dexie(name);
  v1.version(1).stores({ settings: 'id' });
  const row = { id: SETTINGS_ID, openRouterApiKey: 'sk-1', imageModel: 'a/b', refineChatModel: '' };
  await v1.table('settings').put(row);
  v1.close();

  const v2 = new ImagerDb(name);
  await expect(v2.settings.get(SETTINGS_ID)).resolves.toEqual(row);
  expect(v2.verno).toBe(4);
  await expect(v2.images.count()).resolves.toBe(0);
  await expect(v2.runs.count()).resolves.toBe(0);
  await expect(v2.conversations.count()).resolves.toBe(0);
  v2.close();
});

/**
 * The v4 bump adds the `conversations` TABLE to a database whose rows were
 * written by v1 (settings) and v3 (images/runs). Only the new table is
 * declared, so the pin is that nothing else moves: the v1 row, the v3 image
 * and the v3 run all read back with their own meaning at v4.
 */
it('v1 and v3 rows survive the v4 conversations bump untouched', async () => {
  const name = 'imager-migration-test-v4';
  const v1 = new Dexie(name);
  v1.version(1).stores({ settings: 'id' });
  const row = { id: SETTINGS_ID, openRouterApiKey: 'sk-1', imageModel: 'a/b', refineChatModel: '' };
  await v1.table('settings').put(row);
  v1.close();

  const v3 = new Dexie(name);
  v3.version(1).stores({ settings: 'id' });
  v3.version(2).stores({ images: 'id, createdAt, runId', runs: 'id, createdAt' });
  v3.version(3).stores({ images: 'id, createdAt, runId', runs: 'id, createdAt' });
  await v3.table('images').put({
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
  await v3.table('runs').put({
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
  v3.close();

  const v4 = new ImagerDb(name);
  expect(v4.verno).toBe(4);
  await expect(v4.settings.get(SETTINGS_ID)).resolves.toEqual(row);
  const image = await v4.images.get('img-1');
  expect(image).toMatchObject({ prompt: 'v3 image', source: 'generated', runId: 'run-1' });
  expect([...(image?.bytes ?? [])]).toEqual([9, 9]);
  const run = await v4.runs.get('run-1');
  expect(run).toMatchObject({ kind: 'refine', inputImageIds: ['img-0'], costUsd: 0.5 });
  await expect(v4.conversations.count()).resolves.toBe(0);
  v4.close();
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
