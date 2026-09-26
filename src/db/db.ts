import Dexie, { type EntityTable } from 'dexie';

import type { Conversation } from '@/domain/chat';
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
  conversations!: EntityTable<Conversation, 'id'>;

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
    // v4 (slice 4): the chat path's conversations. Only the NEW table is
    // declared; Dexie carries the v1–v3 stores forward, so the bump adds a
    // table and moves nothing (pin: tests/db/migration.test.ts seeds a v1
    // settings row and v3 image/run rows, then opens at v4 and reads them).
    this.version(4).stores({ conversations: 'id, updatedAt' });
    // v5 (favourites): `StoredImage.favorite` is stored data, NOT an index — the
    // gallery still queries by `createdAt` and splits the two groups in the repo
    // (`listImages`), so no store schema moves and every v1–v4 row survives
    // verbatim. Declared anyway, exactly as v3 declared its content change, so
    // the data-shape change is visible next to the indexes that did not change
    // (pin: tests/db/migration.test.ts — a row written WITHOUT the field reads
    // as `false` at v5).
    this.version(5).stores({ images: 'id, createdAt, runId' });
    // v6 (tags): `StoredImage.tags` is stored data, NOT an index — the gallery
    // reads the rows `listImages` already orders and filters them in memory
    // (`src/domain/tags.ts`), so there is no tags table and no store schema
    // moves; every v1–v5 row survives verbatim. Declared anyway, exactly as v3
    // and v5 declared their content changes, so the data-shape change is visible
    // next to the indexes that did not change (pin: tests/db/migration.test.ts —
    // a row written WITHOUT the field reads as `[]` at v6).
    this.version(6).stores({ images: 'id, createdAt, runId' });
  }
}

export const db = new ImagerDb();
