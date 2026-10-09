import { isBlankSheet, type SongSheet } from '@/domain/music';
import type { ChatPanelState } from '@/features/chat/useChat';
import { canGenerateAudio, canWriteSongSheet } from '@/llm/models';

/*
 * The Music tab needs the same two loads the chat path does (settings + the
 * model list), so it reuses `useChat`'s loader rather than a second copy; only
 * the block reasons below are music-specific.
 */

/** Why nothing may be rendered at all, or null. Shared by both actions. */
function renderBlockReason(state: ChatPanelState): string | null {
  const model = state.settings.musicModel;
  if (state.settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (model === '') return 'No music model selected — pick one in Settings.';
  if (state.modelsError !== null) return `Model list failed to load: ${state.modelsError}`;
  if (state.models === null) return 'Loading the model list…';
  const found = state.models.find((m) => m.id === model);
  if (found === undefined) {
    return `The music model “${model}” is not in the current model list — pick another in Settings.`;
  }
  if (!canGenerateAudio(found)) {
    return `The music model “${model}” does not produce audio — pick another in Settings.`;
  }
  return null;
}

/** Why the "Render" button (the sheet as it stands) is disabled, or null. */
export function renderSheetBlockReason(state: ChatPanelState, sheet: SongSheet): string | null {
  return (
    renderBlockReason(state) ??
    (isBlankSheet(sheet) ? 'The song sheet is empty — describe the song below or fill it in.' : null)
  );
}

/**
 * Why a direction may not be sent, or null. A direction needs the writer AND
 * the renderer: there is no fallback from one pick to the other.
 */
export function sendBlockReason(state: ChatPanelState, draft: string): string | null {
  const blocked = renderBlockReason(state);
  if (blocked !== null) return blocked;
  const writer = state.settings.songWriterModel;
  if (writer === '') return 'No song-writer model selected — pick one in Settings.';
  const found = state.models?.find((m) => m.id === writer);
  if (found === undefined) {
    return `The song-writer model “${writer}” is not in the current model list — pick another in Settings.`;
  }
  if (!canWriteSongSheet(found)) {
    return `The song-writer model “${writer}” cannot answer with structured JSON — pick another in Settings.`;
  }
  if (draft.trim() === '') return 'Describe the song, or the change you want.';
  return null;
}
