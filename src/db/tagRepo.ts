import { db } from '@/db/db';

/**
 * THE tags in use across the library — images, videos and audio clips (sounds
 * and voice, docs/17 row 60) share one tag vocabulary (docs/17 row 59). Read as
 * the KEYS of the three multi-entry `*tags` indexes, so no row (and no bytes) is
 * loaded. Alphabetical, each tag once. A tag exists exactly as long as some
 * image, video or clip carries it; there is no tag table.
 */
export async function listTagsInUse(): Promise<string[]> {
  const [imageTags, videoTags, clipTags] = await Promise.all([
    db.images.orderBy('tags').uniqueKeys(),
    db.videos.orderBy('tags').uniqueKeys(),
    db.clips.orderBy('tags').uniqueKeys(),
  ]);
  const all = new Set<string>();
  for (const key of [...imageTags, ...videoTags, ...clipTags]) {
    if (typeof key !== 'string') throw new Error(`A stored tag is not text: ${JSON.stringify(key)}`);
    all.add(key);
  }
  return [...all].sort((a, b) => a.localeCompare(b));
}
