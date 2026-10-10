import { db } from '@/db/db';
import { storedClipSchema, type ClipKind, type StoredClip } from '@/domain/clip';
import { normalizeTags } from '@/domain/tags';

/**
 * The clip repo (docs/17 row 60) — sounds and voice lines alike. zod at the
 * read boundary: a corrupt row THROWS (rule 1/3), it is never served as a
 * shorter list.
 */
function parseClip(row: unknown): StoredClip {
  const parsed = storedClipSchema.safeParse(row);
  if (!parsed.success) throw new Error(`Stored clip is corrupt: ${parsed.error.message}`);
  return parsed.data;
}

/** Every clip, oldest first (the backup's order). */
export async function listClips(): Promise<StoredClip[]> {
  return (await db.clips.orderBy('createdAt').toArray()).map(parseClip);
}

/** The clips of one tab, oldest first. */
export async function listClipsOfKind(kind: ClipKind): Promise<StoredClip[]> {
  return (await db.clips.where('kind').equals(kind).sortBy('createdAt')).map(parseClip);
}

export async function putClip(clip: StoredClip): Promise<void> {
  await db.clips.put(storedClipSchema.parse(clip));
}

/**
 * Set a clip's tags — the twin of `setImageTags` / `setVideoTags`: normalized
 * HERE with the one `normalizeTags`, the row re-read, validated and written back
 * with only the tags swapped, in ONE transaction. A missing row is loud.
 */
export async function setClipTags(id: string, tags: readonly string[]): Promise<void> {
  const normalized = normalizeTags(tags);
  await db.transaction('rw', db.clips, async () => {
    const row = await db.clips.get(id);
    if (row === undefined) throw new Error(`No stored clip with id "${id}" to update.`);
    await db.clips.put({ ...parseClip(row), tags: normalized });
  });
}

export async function deleteClip(id: string): Promise<void> {
  await db.clips.delete(id);
}
