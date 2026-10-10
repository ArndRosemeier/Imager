import { useModelList, type ModelListState } from '@/features/settings/useModelList';
import { canRefineViaChat, listModels, type OpenRouterModel } from '@/llm/models';

/** The two async loads the chat path needs: settings and the model list. */
export type ChatPanelState = ModelListState<OpenRouterModel>;

/** A corrupt settings row throws to the boundary (rule 1/2). */
export function useChat(): { state: ChatPanelState | null; error: Error | null } {
  return useModelList(listModels, 'OpenRouter model list');
}

/**
 * Why a chat turn may not be sent, or null when it may.
 *
 * The chat path uses `settings.refineChatModel` and NOTHING ELSE: unlike the
 * Images API refinement (ledger row 11) there is no fallback to the image
 * model, because this is a different endpoint — the image model may be a
 * generation-only model that cannot produce text at all. An empty refinement
 * pick is a visible blocker, never a substitution.
 *
 * `hasAttachment` (ledger row 16): an attached image IS a message — "start from
 * this" is optional when the picture speaks for itself — so the empty-draft
 * refusal does not apply when one is attached.
 */
export function chatBlockReason(
  state: ChatPanelState,
  draft: string,
  hasAttachment = false,
): string | null {
  const model = state.settings.refineChatModel;
  if (state.settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (model === '') {
    return 'No refinement model selected — the chat path has no fallback to the image model, so pick a refinement model in Settings.';
  }
  if (state.modelsError !== null) return `Model list failed to load: ${state.modelsError}`;
  if (state.models === null) return 'Loading the model list…';
  const found = state.models.find((m) => m.id === model);
  if (found === undefined) {
    return `The refinement model “${model}” is not in the current model list — pick another refinement model in Settings.`;
  }
  if (!canRefineViaChat(found)) {
    return `The refinement model “${model}” cannot answer with text AND images, so it cannot chat-refine — pick another refinement model in Settings.`;
  }
  if (draft.trim() === '' && !hasAttachment) return 'Type a message, or attach an image.';
  return null;
}
