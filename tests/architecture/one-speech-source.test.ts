import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * The Sounds and Voice slice's "exactly one" pins (docs/17 row 60): the two
 * tabs are ONE component over ONE table through ONE speech seam. Each pin goes
 * red when a second implementation appears in src/.
 */
const filesContaining = (needle: string): string[] =>
  sourceFiles('src').filter((f) => readFileSync(f, 'utf8').includes(needle));

it('ONE speech seam talks to /audio/speech, and ONE place renders and stores a clip', () => {
  expect(filesContaining("'/audio/speech'")).toEqual(['src/llm/speech.ts']);
  expect(filesContaining('synthesizeSpeech(').sort()).toEqual([
    'src/features/clips/runClip.ts',
    'src/llm/speech.ts',
  ]);
});

it('Sounds and Voice are one component and one table', () => {
  expect(filesContaining('export function ClipsArea')).toEqual(['src/features/clips/ClipsArea.tsx']);
  expect(filesContaining('<ClipsArea')).toEqual(['src/App.tsx']);
  expect(filesContaining('clips!: EntityTable')).toEqual(['src/db/db.ts']);
});

it('ONE id-stub length for every download name', () => {
  expect(filesContaining('FILE_NAME_ID_STUB_CHARS =')).toEqual(['src/features/export/exportLibrary.ts']);
});
