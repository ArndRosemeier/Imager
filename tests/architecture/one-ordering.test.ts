import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * Rule 4 pin for the favourites ORDER (docs/17 row 32). The owner's ask is one
 * boolean and an ordering: "favourites are just sorted to the top". The ordering
 * therefore lives in exactly ONE place — `listImages` in the image repo — and
 * these pins go red when a second implementation appears (a component sorting
 * the grid itself, or reaching past the repo into the table).
 */

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const REPO = 'src/db/imageRepo.ts';

/**
 * The two ways ONE module would express "favourites on top": partitioning the
 * list on the flag, or sorting a list by it. (A bare `.sort()` that mentions the
 * flag somewhere else in the file is NOT the same thing — the import seam sorts
 * dangling ID STRINGS — so the pattern is anchored on the flag itself.)
 */
const PARTITIONS_ON_FAVORITE = /filter\([^;]{0,60}favorite/;
const SORTS_ON_FAVORITE = /favorite[^;]{0,60}\.sort\(|\.sort\([^;]{0,60}favorite/;

it('exactly one module turns the favourite flag into an ORDER', () => {
  const orderers = sourceFiles('src').filter((file) => {
    const text = stripComments(readFileSync(file, 'utf8'));
    return PARTITIONS_ON_FAVORITE.test(text) || SORTS_ON_FAVORITE.test(text);
  });
  expect(orderers).toEqual([REPO]);
  const repo = stripComments(readFileSync(REPO, 'utf8'));
  expect(repo).toContain('image.favorite');
  expect(repo).toContain('!image.favorite');
});

it('the gallery renders the repo order instead of querying the table', () => {
  const gallery = stripComments(readFileSync('src/features/gallery/Gallery.tsx', 'utf8'));
  expect(gallery).toContain('listImages()');
  expect(gallery).not.toContain('db.images');
  expect(gallery).not.toContain('.sort(');
});
