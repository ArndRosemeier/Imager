import { db } from '@/db/db';
import {
  musicSessionSchema,
  storedSongSchema,
  type MusicSession,
  type StoredSong,
} from '@/domain/music';

/**
 * The music repo (docs/17 row 52). zod at the read boundary: a corrupt row
 * THROWS (rule 1/3), it is never served as a shorter session or a silent song.
 */
function parseSession(row: unknown): MusicSession {
  const parsed = musicSessionSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored music session is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

function parseSong(row: unknown): StoredSong {
  const parsed = storedSongSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored song is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

/** Newest first (by the last turn). */
export async function listMusicSessions(): Promise<MusicSession[]> {
  return (await db.musicSessions.orderBy('updatedAt').reverse().toArray()).map(parseSession);
}

export async function getMusicSession(id: string): Promise<MusicSession | undefined> {
  const row = await db.musicSessions.get(id);
  return row === undefined ? undefined : parseSession(row);
}

/** Every stored song, oldest first (the backup's order; docs/17 row 53). */
export async function listSongs(): Promise<StoredSong[]> {
  return (await db.songs.orderBy('createdAt').toArray()).map(parseSong);
}

export async function getSong(id: string): Promise<StoredSong | undefined> {
  const row = await db.songs.get(id);
  return row === undefined ? undefined : parseSong(row);
}

/**
 * ONE music turn lands atomically: the session (carrying the turn's messages
 * and its current sheet) plus the song it rendered, if any — a session can
 * never point at a song whose write failed.
 */
export async function saveMusicTurn(session: MusicSession, song: StoredSong | null): Promise<void> {
  await db.transaction('rw', db.musicSessions, db.songs, async () => {
    if (song !== null) await db.songs.put(storedSongSchema.parse(song));
    await db.musicSessions.put(musicSessionSchema.parse(session));
  });
}
