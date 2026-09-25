import { useEffect, useState } from 'react';

import { getSettings } from '@/db/settingsRepo';
import type { Settings } from '@/domain/settings';
import { canRefineViaChat, listModels, type OpenRouterModel } from '@/llm/models';
import { errorMessage, toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/** The two async loads the chat path needs: settings and the model list. */
export interface ChatPanelState {
  settings: Settings;
  /** The live model list, or null while it loads. */
  models: OpenRouterModel[] | null;
  modelsError: string | null;
}

/** A corrupt settings row throws to the boundary (rule 1/2). */
export function useChat(): { state: ChatPanelState | null; error: Error | null } {
  const [state, setState] = useState<ChatPanelState | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings().then(
      (settings) => {
        if (cancelled) return;
        setState({ settings, models: null, modelsError: null });
        listModels(settings.openRouterApiKey).then(
          (models) => {
            if (!cancelled) setState((prev) => (prev === null ? prev : { ...prev, models }));
          },
          (modelsFailure: unknown) => {
            if (cancelled) return;
            const message = errorMessage(modelsFailure);
            setState((prev) => (prev === null ? prev : { ...prev, modelsError: message }));
            toastError('Could not load the OpenRouter model list', modelsFailure);
          },
        );
      },
      (loadError: unknown) => {
        if (!cancelled) setError(toError(loadError));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { state, error };
}

/**
 * Why a chat turn may not be sent, or null when it may.
 *
 * The chat path uses `settings.refineChatModel` and NOTHING ELSE: unlike the
 * Images API refinement (ledger row 11) there is no fallback to the image
 * model, because this is a different endpoint — the image model may be a
 * generation-only model that cannot produce text at all. An empty refinement
 * pick is a visible blocker, never a substitution.
 */
export function chatBlockReason(state: ChatPanelState, draft: string): string | null {
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
  if (draft.trim() === '') return 'Type a message to send.';
  return null;
}
