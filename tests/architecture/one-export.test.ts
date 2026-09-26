import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * Rule 4 pins for the export/save seams (docs/17 row 25). The owner's ask is
 * "get my work OUT"; that must be ONE mechanism, not one per surface. These go
 * red when a second zip writer, a second file picker or a second hand-rolled
 * download anchor appears.
 */

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SRC = sourceFiles('src');

function codeFiles(): { file: string; text: string }[] {
  return SRC.map((file) => ({ file, text: stripComments(readFileSync(file, 'utf8')) }));
}

it('exactly one file builds a ZIP — the export seam, with the one zip dependency', () => {
  const hits = SRC.filter((f) => readFileSync(f, 'utf8').includes("from 'fflate'"));
  expect(hits).toEqual(['src/features/export/exportLibrary.ts']);
  // A second zip library, or a hand-rolled writer, is a second mechanism.
  const otherZips = codeFiles()
    .filter(({ file }) => file !== 'src/features/export/exportLibrary.ts')
    .filter(({ text }) => /\b(jszip|zip\.js|fflate|zipSync|new JSZip)\b/.test(text))
    .map(({ file }) => file);
  expect(otherZips).toEqual([]);
});

it('exactly one file reaches for the file picker — the save seam', () => {
  const hits = codeFiles()
    .filter(({ text }) => text.includes('showSaveFilePicker'))
    .map(({ file }) => file);
  expect(hits).toEqual(['src/lib/saveFile.ts']);
});

it('exactly one file owns the anchor-download fallback', () => {
  const hits = codeFiles()
    .filter(({ text }) => text.includes("createElement('a')"))
    .map(({ file }) => file);
  expect(hits).toEqual(['src/lib/saveFile.ts']);
});

it('the save seam has exactly one caller: the shared SaveButton', () => {
  const hits = codeFiles()
    .filter(({ text }) => text.includes('saveFile('))
    .map(({ file }) => file);
  expect(hits.sort()).toEqual(['src/components/ui.tsx', 'src/lib/saveFile.ts']);
});

it('the lightbox uses the save seam, not a hand-rolled <a download>', () => {
  const gallery = readFileSync('src/features/gallery/Gallery.tsx', 'utf8');
  expect(gallery).toContain('SaveButton');
  expect(stripComments(gallery)).not.toContain('download=');
  expect(gallery).not.toContain('href={url}');
});

it('the exporter bakes NO import conflict policy (the owner decides per import)', () => {
  // Owner decision, docs/17 row 25: re-import asks HIM what to do about ids that
  // already exist. "Skip existing" / "replace existing" must not be assumed
  // anywhere in the exporter, or the format would be deciding for him.
  const text = stripComments(readFileSync('src/features/export/exportLibrary.ts', 'utf8'));
  expect(text).not.toMatch(/\b(skip\w*|overwrite\w*|conflict\w*|merge\w*)/i);
});
