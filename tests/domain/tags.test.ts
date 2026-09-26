import { expect, it } from 'vitest';

import { TAG_MAX_CHARS, filterImages, normalizeTag, normalizeTags, tagCounts } from '@/domain/tags';

/**
 * docs/17 row 34 — the tag RULES, pinned as PURE functions over inputs: no
 * database, no DOM, no ordering seam. Three things are defended here:
 *
 *  1. the NORMALIZATION rule (the owner's near-duplicate worry: "so 'orc' and
 *     'Orcs' do not both appear");
 *  2. the DERIVED tag list (a tag no image carries is simply absent, and a tag
 *     two images carry counts 2 — there is no second source of truth);
 *  3. the FILTER, where AND is the intersection and OR the union, so the toggle
 *     actually changes the result set.
 */

/** The one row shape the filter and the count need. */
function image(id: string, tags: string[]): { id: string; tags: string[] } {
  return { id, tags };
}

/* ------------------------------------------------------- normalization */

it('normalizes a tag: trim, collapse inner whitespace, lowercase, cap', () => {
  expect(normalizeTag('  Orc  ')).toBe('orc');
  expect(normalizeTag('Dark   Forest')).toBe('dark forest');
  expect(normalizeTag('\tnight\n')).toBe('night');
  expect(normalizeTag('x'.repeat(TAG_MAX_CHARS + 20))).toBe('x'.repeat(TAG_MAX_CHARS));
});

it('the owner\'s near-duplicate: "Orc" and "orc" are the SAME stored tag', () => {
  // The case rule is the whole guard: both spellings normalize to one string,
  // so they cannot both appear as chips.
  expect(normalizeTag('Orc')).toBe(normalizeTag('orc'));
  expect(normalizeTag('ORC')).toBe(normalizeTag('orc'));
  expect(normalizeTags(['Orc', 'orc', 'ORC', ' orc '])).toEqual(['orc']);
});

it('normalizeTags drops empties, dedupes after normalization, and sorts', () => {
  expect(normalizeTags(['', '   ', 'Forest', 'orc', 'forest'])).toEqual(['forest', 'orc']);
  // One input SET has one canonical array, whatever order it was typed in.
  expect(normalizeTags(['zebra', 'apple'])).toEqual(normalizeTags(['apple', 'zebra']));
});

/**
 * The inflection limit is stated, not hidden: "Orcs" is NOT "orc" (that is tag
 * renaming/merging, deliberately out of this slice). The suggestion list is what
 * keeps the owner from creating it by accident, and that is pinned in the UI
 * suite — here the rule itself is pinned so nobody "fixes" it into a silent
 * stemmer.
 */
it('an inflection is a DIFFERENT tag — merging is deliberately out of scope', () => {
  expect(normalizeTag('Orcs')).not.toBe(normalizeTag('orc'));
  expect(normalizeTags(['orc', 'Orcs'])).toEqual(['orc', 'orcs']);
});

/* ------------------------------------------------------- the derived list */

it('tagCounts is DERIVED from the images: counts 2, and a dropped tag disappears', () => {
  const before = [image('a', ['orc', 'forest']), image('b', ['orc']), image('c', ['city'])];
  expect(tagCounts(before)).toEqual([
    { tag: 'city', count: 1 },
    { tag: 'forest', count: 1 },
    { tag: 'orc', count: 2 },
  ]);

  // The last image carrying "city" loses it: no image carries it any more, so
  // the tag is simply GONE from the list — nothing has to be deleted from a
  // second store, because there is no second store.
  const after = [image('a', ['orc', 'forest']), image('b', ['orc']), image('c', [])];
  expect(tagCounts(after).map((entry) => entry.tag)).toEqual(['forest', 'orc']);
  expect(tagCounts([])).toEqual([]);
});

it('one image counts ONCE per tag even if a stored row repeats it', () => {
  expect(tagCounts([image('a', ['orc', 'orc', 'forest'])])).toEqual([
    { tag: 'forest', count: 1 },
    { tag: 'orc', count: 1 },
  ]);
});

/* ------------------------------------------------------------- the filter */

const LIBRARY = [
  image('fav', ['orc', 'forest']),
  image('newest', ['city']),
  image('middle', ['forest']),
  image('oldest', ['orc']),
];

it('no selection means EVERY image, in the order it was handed in', () => {
  expect(filterImages(LIBRARY, [], 'AND').map((entry) => entry.id)).toEqual([
    'fav',
    'newest',
    'middle',
    'oldest',
  ]);
  expect(filterImages(LIBRARY, [], 'OR').map((entry) => entry.id)).toEqual([
    'fav',
    'newest',
    'middle',
    'oldest',
  ]);
});

it('AND is the INTERSECTION and OR is the UNION — the toggle changes the result set', () => {
  const selected = ['orc', 'forest'];
  // AND = every selected tag: only the image carrying BOTH.
  expect(filterImages(LIBRARY, selected, 'AND').map((entry) => entry.id)).toEqual(['fav']);
  // OR = any selected tag: the image with both, plus both single-tag images.
  expect(filterImages(LIBRARY, selected, 'OR').map((entry) => entry.id)).toEqual([
    'fav',
    'middle',
    'oldest',
  ]);
  // The SAME selection, two DIFFERENT sets — that difference IS the toggle.
  expect(filterImages(LIBRARY, selected, 'AND')).not.toEqual(filterImages(LIBRARY, selected, 'OR'));
});

it('a selection no image satisfies is an EMPTY result, not everything', () => {
  expect(filterImages(LIBRARY, ['orc', 'city'], 'AND')).toEqual([]);
  // ... while OR over the same selection is the union.
  expect(filterImages(LIBRARY, ['orc', 'city'], 'OR').map((entry) => entry.id)).toEqual([
    'fav',
    'newest',
    'oldest',
  ]);
});

it('filtering preserves the input ORDER exactly — it never becomes a second ordering', () => {
  // `listImages` hands in favourites first, newest-first inside each group; the
  // filter may only drop entries, never reorder them.
  const ordered = [image('fav', ['orc']), image('t3', ['orc']), image('t2', ['orc'])];
  expect(filterImages(ordered, ['orc'], 'AND').map((entry) => entry.id)).toEqual([
    'fav',
    't3',
    't2',
  ]);
});
