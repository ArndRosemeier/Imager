import Dexie, { type EntityTable } from 'dexie';

import type { Run, StoredImage } from '@/domain/image';
import type { Settings } from '@/domain/settings';

/** The single settings row lives under this fixed key. */
export const SETTINGS_ID = 'settings';

export type SettingsRow = Settings & { id: typeof SETTINGS_ID };

/** THE Dexie database. Every version lives here; never edit a shipped one. */
export class ImagerDb extends Dexie {
  settings!: EntityTable<SettingsRow, 'id'>;
  images!: EntityTable<StoredImage, 'id'>;
  runs!: EntityTable<Run, 'id'>;

  constructor(name = 'imager') {
    super(name);
    this.version(1).stores({ settings: 'id' });
    this.version(2).stores({ images: 'id, createdAt, runId', runs: 'id, createdAt' });
    // v3 (slice 3): `StoredImage.source`, `Run.kind` and `Run.inputImageIds`
    // are stored fields, NOT indexes — so no store schema moves and every v1/v2
    // row survives verbatim (pin: tests/db/migration.test.ts). The version is
    // declared anyway so the data-shape change is visible here, next to the
    // indexes that did not change.
    this.version(3).stores({ images: 'id, createdAt, runId', runs: 'id, createdAt' });
  }
}

export const db = new ImagerDb();
