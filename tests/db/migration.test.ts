import Dexie from 'dexie';
import { expect, it } from 'vitest';

import { ImagerDb, SETTINGS_ID } from '@/db/db';

it('the v1 settings row survives the v2 bump (images + runs tables)', async () => {
  const name = 'imager-migration-test';
  const v1 = new Dexie(name);
  v1.version(1).stores({ settings: 'id' });
  const row = { id: SETTINGS_ID, openRouterApiKey: 'sk-1', imageModel: 'a/b', refineChatModel: '' };
  await v1.table('settings').put(row);
  v1.close();

  const v2 = new ImagerDb(name);
  await expect(v2.settings.get(SETTINGS_ID)).resolves.toEqual(row);
  expect(v2.verno).toBe(2);
  await expect(v2.images.count()).resolves.toBe(0);
  await expect(v2.runs.count()).resolves.toBe(0);
  v2.close();
});
