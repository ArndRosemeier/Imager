import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * Rule 4 pins for TAGS (docs/17 row 34). The owner asked for "image tags, with a
 * tag bar that has all defined tags and filters with them". The risk that
 * carries is a SECOND SOURCE OF TRUTH: a managed tag list, a `tags` table, or a
 * component re-deriving the bar its own way. These pins go red when that
 * appears.
 *
 * The tag LIST is DERIVED from the image rows (no store, no index); the
 * normalization rule, the derived list and the filter each have exactly ONE
 * definition, in `src/domain/tags.ts`; and the gallery computes the bar from the
 * rows it already read through the ONE ordering seam.
 */

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SRC = sourceFiles('src');

const definers = (signature: string): string[] =>
  SRC.filter((file) => stripComments(readFileSync(file, 'utf8')).includes(signature));

it('the tag rule, the derived list and the filter each have ONE definition', () => {
  expect(definers('export function normalizeTag')).toEqual(['src/domain/tags.ts']);
  expect(definers('export function normalizeTags')).toEqual(['src/domain/tags.ts']);
  expect(definers('export function tagCounts')).toEqual(['src/domain/tags.ts']);
  expect(definers('export function filterImages')).toEqual(['src/domain/tags.ts']);
});

it('there is NO tags table or index — the list lives in the image rows', () => {
  // The database's version declarations must not grow a tag store: a tag exists
  // only as long as an image carries it.
  const db = stripComments(readFileSync('src/db/db.ts', 'utf8'));
  expect(db).not.toContain('tags');
  // No module queries a tags table either.
  const queriers = SRC.filter((file) =>
    /db\.tags\b/.test(stripComments(readFileSync(file, 'utf8'))),
  );
  expect(queriers).toEqual([]);
});

it('the gallery DERIVES the bar from the rows it already read', () => {
  const gallery = stripComments(readFileSync('src/features/gallery/Gallery.tsx', 'utf8'));
  // The bar's input is the filter of the SAME `images` state the grid renders.
  expect(gallery).toContain('tagCounts(images)');
  expect(gallery).toContain('filterImages(images');
  // ... and it still never queries the table itself (the one-ordering pin's
  // companion here): the derived list cannot become a second read path.
  expect(gallery).not.toContain('db.');
});
