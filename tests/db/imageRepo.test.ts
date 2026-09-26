import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { getImage, listImages, setImageFavorite, setImageTags } from '@/db/imageRepo';
import { storedImageSchema, type StoredImage } from '@/domain/image';

/**
 * docs/17 row 32 — favourites. The owner's ask is one boolean and an ordering:
 * "favourites are just sorted to the top". What these pins defend is exactly
 * that, in the ONE place both live: `listImages` returns favourites first,
 * newest-first WITHIN each group, and `setImageFavorite` changes the flag and
 * NOTHING else (the row's bytes are byte-identical after a toggle).
 */

const MODEL = 'google/gemini-2.5-flash-image';

/** A stored row through the app's own boundary schema. */
function row(id: string, createdAt: number, favorite: boolean): StoredImage {
  return storedImageSchema.parse({
    id,
    bytes: new Uint8Array([createdAt, createdAt + 1, createdAt + 2]),
    mimeType: 'image/png',
    width: 2,
    height: 2,
    prompt: `image ${id}`,
    model: MODEL,
    source: 'generated',
    createdAt,
    runId: '',
    favorite,
  });
}

async function seed(rows: readonly StoredImage[]): Promise<void> {
  await db.images.bulkPut(rows);
}

beforeEach(async () => {
  await db.images.clear();
});

it('listImages puts favourites ABOVE newer non-favourites, newest-first inside each group', async () => {
  /*
   * The seed is chosen so BOTH halves of the rule are load-bearing: the
   * favourite at t=1 is older than every non-favourite, so a missing
   * favourite-first split would put it LAST; and the two favourites (t=1, t=4)
   * plus the three non-favourites (t=5, t=3, t=2) would each come out in the
   * wrong internal order if the partition lost the index's newest-first order.
   */
  await seed([
    row('oldest-favourite', 1, true),
    row('third', 3, false),
    row('second', 2, false),
    row('newest-favourite', 4, true),
    row('newest', 5, false),
  ]);

  expect((await listImages()).map((image) => image.id)).toEqual([
    'newest-favourite',
    'oldest-favourite',
    'newest',
    'third',
    'second',
  ]);
});

it('a legacy row with no favorite field reads as NOT a favourite and lands in the lower group', async () => {
  // Written by an app that had no such field (the pre-favourites reading).
  await db.images.put({
    id: 'legacy',
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: 'written before favourites',
    model: MODEL,
    source: 'generated',
    createdAt: 10,
    runId: '',
  } as never);
  await seed([row('favourite', 1, true)]);

  const read = await getImage('legacy');
  expect(read?.favorite).toBe(false);
  expect(Array.from(read?.bytes ?? [])).toEqual([1, 2, 3]);
  // The new favourite floats above it even though the legacy row is NEWER.
  expect((await listImages()).map((image) => image.id)).toEqual(['favourite', 'legacy']);
});

it('toggling changes ONLY the flag: every other field and the bytes are identical', async () => {
  const original = row('toggle-me', 42, false);
  original.bytes = new Uint8Array([9, 8, 7, 6, 5]);
  original.prompt = 'a prompt that must survive the toggle byte for byte';
  await seed([original]);
  const before = await db.images.get('toggle-me');
  if (before === undefined) throw new Error('seed failed');
  expect(Array.from(before.bytes)).toEqual([9, 8, 7, 6, 5]);

  await setImageFavorite('toggle-me', true);

  const after = await db.images.get('toggle-me');
  // The RAW stored row: the flag flipped, nothing else moved — same object
  // shape, same bytes, same prompt, same id.
  expect(after).toEqual({ ...before, favorite: true });
  expect(Array.from(after?.bytes ?? [])).toEqual(Array.from(before.bytes));
  await expect(getImage('toggle-me')).resolves.toMatchObject({ favorite: true });

  // ... and back again, byte-identically.
  await setImageFavorite('toggle-me', false);
  const restored = await db.images.get('toggle-me');
  expect(restored).toEqual(before);
  expect(Array.from(restored?.bytes ?? [])).toEqual(Array.from(before.bytes));
});

it('a toggle of a row that is gone is a LOUD failure, never a silent no-op', async () => {
  await expect(setImageFavorite('never-existed', true)).rejects.toThrow(/never-existed/);
});

/**
 * docs/17 row 34 — the tags write. This is the SAME trap as the favourite
 * toggle (row 32), re-pinned for THIS writer path: `setImageTags` must not use
 * `db.images.update(id, { tags })`, because Dexie's partial update deep-clones
 * the record and can turn the row's `Uint8Array` into a look-alike with no
 * typed-array internal slot — the next read then throws "Stored image is
 * corrupt". The row is therefore read → validated → put, and the whole raw row
 * is compared before/after.
 */
it('setImageTags changes ONLY the tags: the bytes keep their Uint8Array tag, byte-identical', async () => {
  const original = row('tag-me', 7, false);
  original.bytes = new Uint8Array([4, 4, 4, 4]);
  original.prompt = 'a prompt that must survive the tag write byte for byte';
  await seed([original]);
  const before = await db.images.get('tag-me');
  if (before === undefined) throw new Error('seed failed');
  expect(Object.prototype.toString.call(before.bytes)).toBe('[object Uint8Array]');

  // Free typing, normalized AT THE WRITE SEAM: trimmed, whitespace collapsed,
  // lowercased, deduped and sorted — so "Orc" and "orc" are ONE stored tag.
  await setImageTags('tag-me', ['Orc', '  orc ', 'Forest', '', 'dark   forest']);

  const after = await db.images.get('tag-me');
  expect(after).toEqual({ ...before, tags: ['dark forest', 'forest', 'orc'] });
  // The row-32 trap, re-pinned: the stored bytes are still a real Uint8Array and
  // byte-identical, and the READ path (which would throw on a corrupted row)
  // still validates.
  expect(Object.prototype.toString.call(after?.bytes)).toBe('[object Uint8Array]');
  expect(Array.from(after?.bytes ?? [])).toEqual(Array.from(before.bytes));
  await expect(getImage('tag-me')).resolves.toMatchObject({
    tags: ['dark forest', 'forest', 'orc'],
  });

  // ... and clearing them writes `[]`, not a mangled row.
  await setImageTags('tag-me', []);
  const cleared = await db.images.get('tag-me');
  expect(cleared).toEqual({ ...before, tags: [] });
  expect(Array.from(cleared?.bytes ?? [])).toEqual(Array.from(before.bytes));
});

it('a legacy row with no tags field reads as UNTAGGED and can be tagged', async () => {
  // Written by an app that had no tags field (the pre-tags reading).
  await db.images.put({
    id: 'legacy-tags',
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: 'written before tags',
    model: MODEL,
    source: 'generated',
    createdAt: 10,
    runId: '',
  } as never);

  await expect(getImage('legacy-tags')).resolves.toMatchObject({ tags: [] });
  await setImageTags('legacy-tags', ['Orc']);
  await expect(getImage('legacy-tags')).resolves.toMatchObject({ tags: ['orc'] });
  expect(Array.from((await db.images.get('legacy-tags'))?.bytes ?? [])).toEqual([1, 2, 3]);
});

it('a tag write to a row that is gone is a LOUD failure, never a silent no-op', async () => {
  await expect(setImageTags('never-existed', ['orc'])).rejects.toThrow(/never-existed/);
});
