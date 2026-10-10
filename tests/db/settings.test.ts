import { beforeEach, expect, it } from 'vitest';

import { SETTINGS_ID, db } from '@/db/db';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { DEFAULT_SETTINGS } from '@/domain/settings';
import { storeConfigFrom } from '@/server/store-session';

beforeEach(async () => {
  await db.settings.clear();
});

it('defaults are all empty — the app never picks a model', async () => {
  expect(DEFAULT_SETTINGS).toEqual({
    openRouterApiKey: '',
    imageModel: '',
    refineChatModel: '',
    // The Music tab's two picks (docs/17 row 52): empty, never a chosen model.
    musicModel: '',
    songWriterModel: '',
    // The Videos tab's pick (docs/17 row 56): empty too.
    videoModel: '',
    // The ServerStore fields (docs/17 row 42): the deployment and store name
    // are defaults the app MAY know; the KEY and the folder choice are empty
    // until the owner supplies them.
    serverStoreBaseUrl: 'https://store.futuremagic.de',
    serverStoreName: 'imager',
    serverStoreKey: '',
    serverStoreFolder: '',
  });
  await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
});

it('a settings row written before the ServerStore fields reads as UNCONFIGURED', async () => {
  // `.default('')` on the four fields is what makes a pre-slice-38 row (no such
  // keys) read as "no key yet" instead of a corrupt row — the meaning its
  // absence already had (docs/17 row 42).
  await db.settings.put({
    id: SETTINGS_ID,
    openRouterApiKey: 'sk-old',
    imageModel: 'a/b',
    refineChatModel: '',
  } as never);
  // The four fields read as EMPTY (the absence's own meaning); the SEAM turns
  // an empty URL/store into the documented deployment defaults
  // (`storeConfigFrom`), so "unset" is one state, not two.
  await expect(getSettings()).resolves.toEqual({
    openRouterApiKey: 'sk-old',
    imageModel: 'a/b',
    refineChatModel: '',
    // A pre-Music row reads the two music picks as unselected (docs/17 row 52).
    musicModel: '',
    songWriterModel: '',
    videoModel: '',
    serverStoreBaseUrl: '',
    serverStoreName: '',
    serverStoreKey: '',
    serverStoreFolder: '',
  });
  expect(storeConfigFrom(await getSettings())).toEqual({
    baseUrl: 'https://store.futuremagic.de',
    store: 'imager',
    key: '',
    folder: '',
  });
});

it('round-trips an update', async () => {
  await updateSettings({ imageModel: 'a/b' });
  await expect(getSettings()).resolves.toEqual({ ...DEFAULT_SETTINGS, imageModel: 'a/b' });
});

it('a corrupt row throws instead of defaulting', async () => {
  await db.settings.put({ id: SETTINGS_ID, openRouterApiKey: 42 } as never);
  await expect(getSettings()).rejects.toThrow(/Stored settings are corrupt/);
});
