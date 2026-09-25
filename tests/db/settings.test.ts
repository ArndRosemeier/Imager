import { beforeEach, expect, it } from 'vitest';

import { SETTINGS_ID, db } from '@/db/db';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { DEFAULT_SETTINGS } from '@/domain/settings';

beforeEach(async () => {
  await db.settings.clear();
});

it('defaults are all empty — the app never picks a model', async () => {
  expect(DEFAULT_SETTINGS).toEqual({ openRouterApiKey: '', imageModel: '', refineChatModel: '' });
  await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
});

it('round-trips an update', async () => {
  await updateSettings({ imageModel: 'a/b' });
  await expect(getSettings()).resolves.toEqual({ ...DEFAULT_SETTINGS, imageModel: 'a/b' });
});

it('a corrupt row throws instead of defaulting', async () => {
  await db.settings.put({ id: SETTINGS_ID, openRouterApiKey: 42 } as never);
  await expect(getSettings()).rejects.toThrow(/Stored settings are corrupt/);
});
