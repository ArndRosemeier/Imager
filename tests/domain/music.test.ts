import { expect, it } from 'vitest';

import { EMPTY_SONG_SHEET, isBlankSheet, musicSessionTitle, renderPrompt } from '@/domain/music';

const SHEET = {
  ...EMPTY_SONG_SHEET,
  title: 'Night Drive',
  style: '80s synthwave',
  mood: 'nostalgic',
  vocals: 'airy female lead',
  length: 'about 2 minutes',
  lyrics: '[Verse]\nNeon on the water',
};

it('renders one labelled line per filled field, lyrics last, nothing guessed', () => {
  expect(renderPrompt(SHEET)).toBe(
    [
      'Title: Night Drive',
      'Style: 80s synthwave',
      'Mood: nostalgic',
      'Vocals: airy female lead',
      'Length: about 2 minutes',
      '',
      'Lyrics:',
      '[Verse]\nNeon on the water',
    ].join('\n'),
  );
});

it('instrumental drops the vocals and the lyrics and says so explicitly', () => {
  const prompt = renderPrompt({ ...SHEET, instrumental: true });
  expect(prompt).toContain('Instrumental only. No vocals, no sung lyrics, no spoken word.');
  expect(prompt).not.toContain('airy female lead');
  expect(prompt).not.toContain('Neon on the water');
});

it('a blank sheet is blank whatever the instrumental flag says', () => {
  expect(isBlankSheet(EMPTY_SONG_SHEET)).toBe(true);
  expect(isBlankSheet({ ...EMPTY_SONG_SHEET, instrumental: true, mood: '  ' })).toBe(true);
  expect(isBlankSheet({ ...EMPTY_SONG_SHEET, lyrics: 'la' })).toBe(false);
});

it('the session title is the sheet title, else the first direction, else a plain label', () => {
  expect(musicSessionTitle(SHEET, 'ignored')).toBe('Night Drive');
  expect(musicSessionTitle({ ...SHEET, title: '' }, 'A song about rain\nmore')).toBe(
    'A song about rain',
  );
  expect(musicSessionTitle(null, '')).toBe('Untitled song');
});
