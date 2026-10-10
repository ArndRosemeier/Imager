import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * The music slice's "exactly one" pins (docs/17 row 52, AGENTS rule 4 made
 * mechanical): each goes red when a second implementation of the same idea
 * appears in src/.
 */
const filesContaining = (needle: string): string[] =>
  sourceFiles('src').filter((f) => readFileSync(f, 'utf8').includes(needle));

it('ONE server-sent-events reader: the stream is read only in the transport seam', () => {
  expect(filesContaining('getReader(')).toEqual(['src/llm/client.ts']);
});

it('ONE reader of the owner’s music direction: the song writer, called from the turn alone', () => {
  // Free text is read by a MODEL (rule 5); a second caller would be a second
  // place deciding what a direction means.
  expect(filesContaining('writeSongSheet(')).toEqual([
    'src/features/music/runMusicTurn.ts',
    'src/features/music/songWriter.ts',
  ]);
});

it('ONE audio-format decision: bytes are typed by their signature in one module', () => {
  expect(filesContaining('function sniffAudioFormat')).toEqual(['src/lib/audioFormat.ts']);
  expect(filesContaining('sniffAudioFormat(')).toEqual([
    'src/lib/audioFormat.ts',
    'src/llm/music.ts',
    'src/llm/speech.ts',
  ]);
});

it('ONE place a song request body is built: audio output lives in the music seam', () => {
  expect(filesContaining("modalities: ['text', 'audio']")).toEqual(['src/llm/music.ts']);
});

it('ONE hook owns an in-memory object URL’s lifetime (the gallery and the player share it)', () => {
  // `saveFile` (a download anchor) and `useStoreThumbnail` (an ASYNC load that
  // owns its own cancellation) are the two other, different lifetimes.
  expect(filesContaining('URL.createObjectURL(').sort()).toEqual([
    'src/features/store/useStoreThumbnail.ts',
    'src/lib/saveFile.ts',
    'src/lib/useObjectUrl.ts',
  ]);
});
