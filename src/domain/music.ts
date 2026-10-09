import { z } from 'zod';

import { conversationTitle } from '@/domain/chat';

/**
 * The Music tab's data (docs/17 row 52).
 *
 * WHY A SONG SHEET. The music models on OpenRouter (Google Lyria 3) are
 * single-turn and take no audio input: a song cannot be sent back to be edited.
 * So refinement happens one level up — on the SHEET, the structured recipe a
 * song is rendered from. The owner's free-text direction is read by a writer
 * model into a new, zod-validated sheet (AGENTS rule 5: free text is read by
 * the MODEL, never a regex), the sheet is SHOWN and editable (a wrong read is
 * correctable in one step), and every render is a fresh take of that sheet.
 */
export const songSheetSchema = z.strictObject({
  title: z.string(),
  /** Genre and production style, e.g. "80s synthwave, analog synths". */
  style: z.string(),
  mood: z.string(),
  /** Free description: "slow, around 70 BPM". */
  tempo: z.string(),
  instrumentation: z.string(),
  /** Who sings and how; ignored when `instrumental`. */
  vocals: z.string(),
  instrumental: z.boolean(),
  /** Free description: "about 2 minutes". Lyria Clip is always 30 s. */
  length: z.string(),
  /** Lyrics with section tags such as `[Verse]`, `[Chorus]`, `[Bridge]`. */
  lyrics: z.string(),
});
export type SongSheet = z.infer<typeof songSheetSchema>;

export const EMPTY_SONG_SHEET: SongSheet = {
  title: '',
  style: '',
  mood: '',
  tempo: '',
  instrumentation: '',
  vocals: '',
  instrumental: false,
  length: '',
  lyrics: '',
};

/** True when nothing in the sheet would tell a model what to play. */
export function isBlankSheet(sheet: SongSheet): boolean {
  return Object.entries(sheet).every(([key, value]) =>
    key === 'instrumental' ? true : (value as string).trim() === '',
  );
}

/**
 * THE render prompt: the sheet as the plain labelled text a music model reads,
 * one line per filled field, lyrics last. Deterministic and pure — the same
 * sheet always renders the same prompt, so a re-render differs only by the
 * model's own variation. Empty fields are left out, never filled with a guess.
 */
export function renderPrompt(sheet: SongSheet): string {
  const lines: string[] = [];
  const add = (label: string, value: string): void => {
    if (value.trim() !== '') lines.push(`${label}: ${value.trim()}`);
  };
  add('Title', sheet.title);
  add('Style', sheet.style);
  add('Mood', sheet.mood);
  add('Tempo', sheet.tempo);
  add('Instrumentation', sheet.instrumentation);
  if (sheet.instrumental) lines.push('Instrumental only. No vocals, no sung lyrics, no spoken word.');
  else add('Vocals', sheet.vocals);
  add('Length', sheet.length);
  if (!sheet.instrumental && sheet.lyrics.trim() !== '') {
    lines.push('', 'Lyrics:', sheet.lyrics.trim());
  }
  return lines.join('\n');
}

const bytesSchema = z.custom<Uint8Array<ArrayBuffer>>(
  (v) => Object.prototype.toString.call(v) === '[object Uint8Array]',
);

/** One rendered song. Bytes live here, never inside the session. */
export const storedSongSchema = z.strictObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  bytes: bytesSchema,
  mimeType: z.string().min(1),
  title: z.string(),
  /** The sheet this take was rendered from. */
  sheet: songSheetSchema,
  /** The exact prompt sent (`renderPrompt(sheet)`). */
  prompt: z.string(),
  /** The lyrics as the model sang them (`delta.audio.transcript`). */
  transcript: z.string(),
  model: z.string().min(1),
  costUsd: z.number().nullable(),
  createdAt: z.number(),
});
export type StoredSong = z.infer<typeof storedSongSchema>;

/**
 * What the owner did in a turn: sent a free-text direction (`message`), or
 * rendered the sheet as it stands, possibly hand-edited (`render`).
 */
export const MUSIC_ACTIONS = ['message', 'render'] as const;

export const musicMessageSchema = z.strictObject({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  action: z.enum(MUSIC_ACTIONS),
  /** User: the direction, verbatim (NEVER parsed). Assistant: the writer's
   * one-line account of what it changed — the read, named on screen. */
  text: z.string(),
  /** Assistant: the sheet after this turn; null when the sheet did not change. */
  sheet: songSheetSchema.nullable(),
  /** Assistant: the song this turn rendered; '' when none was rendered. */
  songId: z.string(),
  writerModel: z.string(),
  musicModel: z.string(),
  writerCostUsd: z.number().nullable(),
  renderCostUsd: z.number().nullable(),
  /** The failure of a failed turn; null otherwise. */
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type MusicMessage = z.infer<typeof musicMessageSchema>;

export const musicSessionSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  /** The current sheet; null until the first turn wrote or rendered one. */
  sheet: songSheetSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(musicMessageSchema),
});
export type MusicSession = z.infer<typeof musicSessionSchema>;

/**
 * A session's title: the sheet's own title once there is one, else the first
 * direction's first line (the chat seam's display truncation, reused).
 */
export function musicSessionTitle(sheet: SongSheet | null, firstText: string): string {
  const fromSheet = sheet?.title.trim() ?? '';
  if (fromSheet !== '') return fromSheet;
  const fromText = conversationTitle(firstText);
  return fromText === '' ? 'Untitled song' : fromText;
}
