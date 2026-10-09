import { z } from 'zod';

import { songSheetSchema, type SongSheet } from '@/domain/music';
import { chatCompletion } from '@/llm/chat';
import { OpenRouterError } from '@/llm/errors';

/**
 * THE song writer (docs/17 row 52): the ONE place the owner's free-text music
 * direction is read — by a MODEL, into a zod-validated song sheet (AGENTS rule
 * 5). No pattern is ever run over the direction. The writer answers
 * `sheet: null` when the text asks for no change to the song (a question, "just
 * try again"), and its `summary` is shown on screen, so what it read is named
 * and a wrong read is correctable in one step (edit the sheet, or say so).
 */
export const songWriterAnswerSchema = z.strictObject({
  /** One sentence: what was changed, or why nothing was. Shown verbatim. */
  summary: z.string().min(1),
  /** The WHOLE new sheet, or null when the direction asks for no change. */
  sheet: songSheetSchema.nullable(),
});
export type SongWriterAnswer = z.infer<typeof songWriterAnswerSchema>;

/** The strict `json_schema` response format, derived from the zod schema so the
 * two cannot drift. `$schema` is dropped: providers take the bare schema. */
function responseFormat(): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(songWriterAnswerSchema);
  return {
    type: 'json_schema',
    json_schema: { name: 'song_sheet_edit', strict: true, schema },
  };
}

export const SONG_WRITER_BRIEF = `You keep the song sheet for a music-generation model (Google Lyria).
You receive the current sheet as JSON (or null when there is none yet) and the owner's direction in their own words.

Answer with JSON only:
- "sheet": the COMPLETE new sheet after applying the direction. Keep every field the direction does not touch exactly as it was. When starting from null, fill in every field the direction implies and leave the rest as empty strings.
- "sheet": null when the direction asks for no change to the song (for example a question, or "try again" / "another take"). Do not invent changes.
- "summary": one short sentence naming what you changed (or, with a null sheet, answering the owner briefly).

Field guidance:
- style: genre and production; mood; tempo (e.g. "slow, around 70 BPM"); instrumentation; vocals (who sings and how).
- instrumental: true only for music without any vocals; then lyrics stay empty.
- length: e.g. "about 2 minutes".
- lyrics: original lyrics with section tags on their own lines, such as [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro]. Write lyrics when the song has vocals and none exist yet.
- Never name real artists or use existing copyrighted lyrics; describe the sound instead.
- Write the lyrics in the language the owner asks for; otherwise in the language of the direction.`;

export interface SongWriterRequest {
  apiKey: string;
  model: string;
  /** The sheet as it stands on screen (possibly hand-edited); null for a new song. */
  current: SongSheet | null;
  /** The owner's direction, verbatim. */
  direction: string;
  signal?: AbortSignal | undefined;
}

export interface SongWriterResult {
  answer: SongWriterAnswer;
  model: string;
  costUsd: number | null;
}

/**
 * One writer call through the ONE chat seam (text out, strict JSON schema). An
 * answer that is not JSON or fails the schema THROWS — it is never read as "no
 * change" (rule 3).
 */
export async function writeSongSheet(req: SongWriterRequest): Promise<SongWriterResult> {
  const result = await chatCompletion({
    apiKey: req.apiKey,
    model: req.model,
    modalities: ['text'],
    responseFormat: responseFormat(),
    messages: [
      { role: 'system', text: SONG_WRITER_BRIEF },
      {
        role: 'user',
        text: `Current sheet:\n${JSON.stringify(req.current)}\n\nDirection:\n${req.direction}`,
      },
    ],
    signal: req.signal,
  });
  let json: unknown;
  try {
    json = JSON.parse(result.text);
  } catch (error) {
    throw new OpenRouterError(
      'invalid-response',
      200,
      `the song writer did not answer with JSON (${String(error)}): ${result.text.slice(0, 120)}`,
    );
  }
  const parsed = songWriterAnswerSchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenRouterError(
      'invalid-response',
      200,
      `the song writer's answer failed validation: ${parsed.error.message}`,
    );
  }
  return { answer: parsed.data, model: result.model, costUsd: result.costUsd };
}
