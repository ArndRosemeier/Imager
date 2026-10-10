import { useEffect, useState } from 'react';

import { getSettings } from '@/db/settingsRepo';
import type { Settings } from '@/domain/settings';
import { errorMessage, toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/** Settings plus one live model list — what a model-driven tab loads first. */
export interface ModelListState<M> {
  settings: Settings;
  /** The live list, or null while it loads. */
  models: M[] | null;
  modelsError: string | null;
}

/**
 * THE "settings, then the model list" loader (the chat, music and video tabs
 * all go through it; only the list differs). A corrupt settings row throws to
 * the boundary (rule 1/2); a list failure is shown in the state AND toasted.
 */
export function useModelList<M>(
  load: (apiKey: string) => Promise<M[]>,
  listName: string,
): { state: ModelListState<M> | null; error: Error | null } {
  const [state, setState] = useState<ModelListState<M> | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings().then(
      (settings) => {
        if (cancelled) return;
        setState({ settings, models: null, modelsError: null });
        load(settings.openRouterApiKey).then(
          (models) => {
            if (!cancelled) setState((prev) => (prev === null ? prev : { ...prev, models }));
          },
          (modelsFailure: unknown) => {
            if (cancelled) return;
            const message = errorMessage(modelsFailure);
            setState((prev) => (prev === null ? prev : { ...prev, modelsError: message }));
            toastError(`Could not load the ${listName}`, modelsFailure);
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
  }, [load, listName]);

  return { state, error };
}
