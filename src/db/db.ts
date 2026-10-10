import Dexie, { type EntityTable } from 'dexie';

import type { Conversation } from '@/domain/chat';
import type { Run, StoredImage } from '@/domain/image';
import type { MusicSession, StoredSong } from '@/domain/music';
import type { Settings } from '@/domain/settings';
import type { StoredVideo, VideoJob } from '@/domain/video';

/** The single settings row lives under this fixed key. */
export const SETTINGS_ID = 'settings';

export type SettingsRow = Settings & { id: typeof SETTINGS_ID };

/**
 * One cached ServerStore thumbnail (docs/17 row 42). Keyed by the OBJECT NAME
 * the store serves; `sha256` is the hash of the ORIGINAL it was derived from,
 * which is what makes a listing that reports a new hash invalidate the row.
 * Both `name` and `sha256` are indexed so a change can be swept without a scan.
 */
export interface StoreThumbRow {
  name: string;
  sha256: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  width: number;
  height: number;
  cachedAt: number;
}

/**
 * One cached ServerStore ORIGINAL, exactly as the service served it (docs/17
 * row 42). The store holds full quality; this row is a copy of it, not a
 * reduced one, so a download can be byte-identical to the upload without a
 * round trip. Same invalidation key as the thumbnail.
 */
export interface StoreObjectRow {
  name: string;
  sha256: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  width: number;
  height: number;
  cachedAt: number;
}

/** THE Dexie database. Every version lives here; never edit a shipped one. */
export class ImagerDb extends Dexie {
  settings!: EntityTable<SettingsRow, 'id'>;
  images!: EntityTable<StoredImage, 'id'>;
  runs!: EntityTable<Run, 'id'>;
  conversations!: EntityTable<Conversation, 'id'>;
  storeThumbs!: EntityTable<StoreThumbRow, 'name'>;
  storeObjects!: EntityTable<StoreObjectRow, 'name'>;
  songs!: EntityTable<StoredSong, 'id'>;
  musicSessions!: EntityTable<MusicSession, 'id'>;
  videos!: EntityTable<StoredVideo, 'id'>;
  videoJobs!: EntityTable<VideoJob, 'id'>;

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
    // v7 (ServerStore, docs/17 row 42): two NEW tables for the local cache of
    // store objects (the originals) and the browser thumbnails derived from
    // them. They are a CACHE, not library data: nothing here is ever exported,
    // imported, or written back to the store, and an empty cache is a working
    // state (every path refetches). Only the new stores are declared, so Dexie
    // carries every v1-v6 store and row forward untouched.
    this.version(7).stores({
      storeThumbs: 'name, sha256, cachedAt',
      storeObjects: 'name, sha256, cachedAt',
    });
    // v8 (Music tab, docs/17 row 52): two NEW tables. `songs` holds the rendered
    // audio (bytes as Uint8Array, like images) and `musicSessions` the song
    // chats, whose messages reference songs by id — never bytes. Only the new
    // stores are declared, so every v1-v7 store and row is carried forward.
    this.version(8).stores({
      songs: 'id, createdAt, sessionId',
      musicSessions: 'id, updatedAt',
    });
    // v9 (Videos tab, docs/17 row 56): two NEW tables. `videoJobs` holds the
    // jobs OpenRouter is still working on (or that failed), stored the moment
    // they are submitted so a paid job survives a tab switch or a reload;
    // `videos` holds the finished videos (bytes as Uint8Array, like images and
    // songs). Only the new stores are declared; every v1-v8 store is carried.
    this.version(9).stores({
      videos: 'id, createdAt',
      videoJobs: 'id, createdAt',
    });
  }
}

export const db = new ImagerDb();
