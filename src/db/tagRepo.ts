import { db } from '@/db/db';

/**
 * THE tags in use across the library — images AND videos share one tag
 * vocabulary (docs/17 row 59). Read as the KEYS of the two multi-entry `*tags`
 * indexes, so no row (and no image or video bytes) is loaded. Alphabetical,
 * each tag once. A tag exists exactly as long as some image or video carries
 * it; there is no tag table.
 */
export async function listTagsInUse(): Promise<string[]> {
  const [imageTags, videoTags] = await Promise.all([
    db.images.orderBy('tags').uniqueKeys(),
    db.videos.orderBy('tags').uniqueKeys(),
  ]);
  const all = new Set<string>();
  for (const key of [...imageTags, ...videoTags]) {
    if (typeof key !== 'string') throw new Error(`A stored tag is not text: ${JSON.stringify(key)}`);
    all.add(key);
  }
  return [...all].sort((a, b) => a.localeCompare(b));
}
