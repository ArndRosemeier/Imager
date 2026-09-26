import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * Rule 4 pins for the clipboard seam (docs/17 row 22). A prompt is the most
 * reusable text the app produces, so "get it out" has ONE mechanism: the
 * `copyText` seam in `src/lib/clipboard.ts`, reached only through the ONE shared
 * `CopyButton`. These go red when a second copy path appears.
 */

it('exactly one file touches navigator.clipboard — the seam', () => {
  const hits = sourceFiles('src').filter((f) =>
    readFileSync(f, 'utf8').includes('navigator.clipboard'),
  );
  expect(hits).toEqual(['src/lib/clipboard.ts']);
});

it('the copy seam has exactly one caller: the shared CopyButton', () => {
  const hits = sourceFiles('src').filter((f) => readFileSync(f, 'utf8').includes('copyText('));
  // The seam's own declaration plus the single control that uses it. Sorted:
  // the walker's order is the filesystem's, not ours.
  expect(hits.sort()).toEqual(['src/components/ui.tsx', 'src/lib/clipboard.ts']);
});

it('no legacy execCommand copy fallback exists', () => {
  // The rejected fallback (docs/17 row 22): a second, deprecated copy
  // mechanism that can silently do nothing. Its absence is pinned, not prose —
  // and the check reads CODE, because the seam's comment names the mechanism it
  // refused.
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const offenders = sourceFiles('src').filter((f) =>
    stripComments(readFileSync(f, 'utf8')).includes('execCommand'),
  );
  expect(offenders).toEqual([]);
});

it('the gallery tile keeps the open control AND a sibling copy control', () => {
  const gallery = readFileSync('src/features/gallery/Gallery.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // The accessible name several suites query by must survive the restructure.
  expect(gallery).toContain('Open image: ${image.prompt}');
  // Both the lightbox (primary case) and the tile carry the one control.
  expect(gallery.split('<CopyButton').length - 1).toBe(2);
});
