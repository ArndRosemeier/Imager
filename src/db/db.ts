import Dexie, { type EntityTable } from 'dexie';

import type { Settings } from '@/domain/settings';

/** The single settings row lives under this fixed key. */
export const SETTINGS_ID = 'settings';

export type SettingsRow = Settings & { id: typeof SETTINGS_ID };

/** THE Dexie database. One table today; later slices add versions here. */
export class ImagerDb extends Dexie {
  settings!: EntityTable<SettingsRow, 'id'>;

  constructor() {
    super('imager');
    this.version(1).stores({ settings: 'id' });
  }
}

export const db = new ImagerDb();
