import { getMusicSession, saveMusicTurn } from '@/db/musicRepo';
import {
  isBlankSheet,
  musicSessionTitle,
  renderPrompt,
  type MusicMessage,
  type MusicSession,
  type SongSheet,
  type StoredSong,
} from '@/domain/music';
import { writeSongSheet } from '@/features/music/songWriter';
import { renderMusic } from '@/llm/music';
import { errorMessage, toError } from '@/lib/errors';

/** Which step a turn is on, for the owner-facing progress line. */
export type MusicTurnPhase = 'writing' | 'rendering';

export interface MusicTurnInput {
  apiKey: string;
  /** `settings.musicModel` — the renderer. No fallback. */
  musicModel: string;
  /** `settings.songWriterModel` — used only by a `message` turn. No fallback. */
  writerModel: string;
  /** The open session, or null to start a new one. */
  sessionId: string | null;
  /**
   * `message`: the direction goes to the writer, and the new sheet is rendered
   * (nothing is rendered when the writer answers "no change").
   * `render`: the sheet as it stands — possibly hand-edited — is rendered as is.
   */
  action: 'message' | 'render';
  /** The direction (a `message` turn); '' for a `render` turn. */
  text: string;
  /** The sheet on screen, which is the CURRENT sheet (hand edits included). */
  sheet: SongSheet | null;
  signal?: AbortSignal | undefined;
  onPhase?: ((phase: MusicTurnPhase) => void) | undefined;
}

export interface MusicTurnResult {
  /** The session AS STORED, including a failed assistant turn. */
  session: MusicSession;
  /** The song this turn rendered, or null. */
  song: StoredSong | null;
  /** Non-null when the turn failed; the same message is stored AND returned. */
  error: Error | null;
}

/**
 * ONE music turn → the session's new messages, plus at most one song.
 *
 * Every song lands in the `songs` table with the sheet and exact prompt it came
 * from. A failed turn is RECORDED (an assistant message carrying the error) and
 * returned as `error` rather than thrown, exactly like the chat turn: the
 * caller needs the session identity the failure may have just created. When the
 * writer succeeded but the render failed, the NEW sheet is still kept — the
 * owner's direction was read, and "Render" retries it without paying the
 * writer again. A failure of the store itself does throw.
 */
export async function runMusicTurn(input: MusicTurnInput): Promise<MusicTurnResult> {
  const existing =
    input.sessionId === null ? null : ((await getMusicSession(input.sessionId)) ?? null);
  if (input.sessionId !== null && existing === null) {
    throw new Error(`Song ${input.sessionId} no longer exists`);
  }
  const now = Date.now();
  const userMessage: MusicMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    action: input.action,
    text: input.text,
    sheet: null,
    songId: '',
    writerModel: '',
    musicModel: '',
    writerCostUsd: null,
    renderCostUsd: null,
    error: null,
    createdAt: now,
  };
  const base: MusicSession = existing ?? {
    id: crypto.randomUUID(),
    title: '',
    sheet: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const firstText = base.messages.find((m) => m.role === 'user' && m.text !== '')?.text ?? input.text;

  // What the turn has established so far; a failure keeps whatever it got.
  let sheet: SongSheet | null = input.sheet;
  let sheetChanged = false;
  let summary = '';
  let writerModel = '';
  let writerCostUsd: number | null = null;
  let song: StoredSong | null = null;

  const finish = async (error: unknown): Promise<MusicTurnResult> => {
    const assistant: MusicMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      action: input.action,
      text: summary,
      sheet: sheetChanged || input.action === 'render' ? sheet : null,
      songId: song?.id ?? '',
      writerModel,
      musicModel: song?.model ?? (input.action === 'render' || sheetChanged ? input.musicModel : ''),
      writerCostUsd,
      renderCostUsd: song?.costUsd ?? null,
      error: error === null ? null : errorMessage(error),
      createdAt: Date.now(),
    };
    const session: MusicSession = {
      ...base,
      title: musicSessionTitle(sheet, firstText),
      sheet,
      updatedAt: Date.now(),
      messages: [...base.messages, userMessage, assistant],
    };
    await saveMusicTurn(session, song);
    return { session, song, error: error === null ? null : toError(error) };
  };

  let failure: unknown = null;
  try {
    if (input.action === 'message') {
      input.onPhase?.('writing');
      const written = await writeSongSheet({
        apiKey: input.apiKey,
        model: input.writerModel,
        current: input.sheet,
        direction: input.text,
        signal: input.signal,
      });
      writerModel = written.model;
      writerCostUsd = written.costUsd;
      summary = written.answer.summary;
      if (written.answer.sheet !== null) {
        sheet = written.answer.sheet;
        sheetChanged = true;
      }
    }
    // A writer that asked for no change renders nothing: a new take is the
    // owner's explicit "Render", never money spent on a question.
    if (input.action === 'render' || sheetChanged) {
      if (sheet === null || isBlankSheet(sheet)) {
        throw new Error('The song sheet is empty — describe the song or fill in the sheet first.');
      }
      input.onPhase?.('rendering');
      const prompt = renderPrompt(sheet);
      const rendered = await renderMusic({
        apiKey: input.apiKey,
        model: input.musicModel,
        prompt,
        signal: input.signal,
      });
      song = {
        id: crypto.randomUUID(),
        sessionId: base.id,
        bytes: rendered.bytes,
        mimeType: rendered.mimeType,
        title: musicSessionTitle(sheet, firstText),
        sheet,
        prompt,
        transcript: rendered.transcript,
        model: rendered.model,
        costUsd: rendered.costUsd,
        createdAt: Date.now(),
      };
    }
  } catch (error) {
    failure = error;
  }
  // Outside the try: a failure of the STORE is not a failed turn, it throws.
  return finish(failure);
}
