/**
 * DISPATCHER's own verification of docs/17 row 32 — the favourites toggle.
 *
 * Two things are pinned here, and the second is the reason this file exists:
 * the safe toggle changes the flag and NOTHING else, and the OBVIOUS unsafe
 * implementation (`db.images.update(id, { favorite })`) is demonstrated in a
 * test to corrupt the row, so the next reader has the trap in executable form
 * rather than in prose. The brief that ordered this slice recommended that
 * unsafe call; the writer disproved it.
 */
import { expect, it } from 'vitest';

import { db } from '@/db/db';
import { getImage, setImageFavorite } from '@/db/imageRepo';

function seededRow(id: string) {
  return {
    id,
    bytes: new Uint8Array([9, 8, 7, 6]),
    mimeType: 'image/png',
    width: 4,
    height: 4,
    prompt: `cos ${id}`,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated' as const,
    createdAt: 1,
    runId: '',
    favorite: false,
  };
}

it('COS: the real toggle flips only the flag and leaves the bytes intact', async () => {
  await db.images.clear();
  await db.images.put(seededRow('cos-safe'));

  await setImageFavorite('cos-safe', true);

  const raw = await db.images.get('cos-safe');
  // The structured-clone tag survives — this is what a corrupt row loses.
  expect(Object.prototype.toString.call((raw as { bytes: unknown }).bytes)).toBe(
    '[object Uint8Array]',
  );
  const read = await getImage('cos-safe');
  expect([...(read?.bytes ?? [])]).toEqual([9, 8, 7, 6]);
  expect(read?.favorite).toBe(true);
  // …and the round trip through the schema still parses (a corrupt row throws).
  await expect(getImage('cos-safe')).resolves.toBeDefined();
});

it('COS: the trap — a raw partial Dexie update does NOT preserve the bytes tag', async () => {
  await db.images.clear();
  await db.images.put(seededRow('cos-trap'));

  await db.images.update('cos-trap', { favorite: true });

  const raw = await db.images.get('cos-trap');
  const tag = Object.prototype.toString.call((raw as { bytes: unknown }).bytes);
  // Measured in this environment: Dexie deep-clones the record and the typed
  // array comes back as a look-alike object. If a future Dexie version fixes
  // this, the assertion below flips and the trap note is obsolete — which is
  // exactly the signal a reader should get.
  expect(tag).toBe('[object Object]');
  await expect(getImage('cos-trap')).rejects.toThrow(/corrupt/i);
});
