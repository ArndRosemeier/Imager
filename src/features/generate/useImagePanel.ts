import { useEffect, useState } from 'react';

import { getSettings } from '@/db/settingsRepo';
import type { Settings } from '@/domain/settings';
import { limitsFor, listImageModelLimits, type ImageModelLimits } from '@/llm/imageModels';
import { errorMessage, toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/** Settings + the selected model's published limits — the two async loads
 * EVERY generation-path panel needs (the text-to-image form and the refine
 * form). ONE hook, so the disabled-reason logic reads the same state in both. */
export interface ImagePanelState {
  settings: Settings;
  limits: ImageModelLimits | null;
  limitsError: string | null;
}

/** A corrupt settings row throws to the boundary (rule 1/2). */
export function useImagePanel(): { state: ImagePanelState | null; error: Error | null } {
  const [state, setState] = useState<ImagePanelState | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings().then(
      (settings) => {
        if (cancelled) return;
        setState({ settings, limits: null, limitsError: null });
        if (settings.imageModel === '') return;
        listImageModelLimits(settings.openRouterApiKey).then(
          (all) => {
            if (cancelled) return;
            setState((prev) =>
              prev === null ? prev : { ...prev, limits: limitsFor(all, settings.imageModel) },
            );
          },
          (limitError: unknown) => {
            if (cancelled) return;
            setState((prev) =>
              prev === null ? prev : { ...prev, limitsError: errorMessage(limitError) },
            );
            toastError('Could not load the image-model limits', limitError);
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

/** Why a create/refine request may not run, or null when it may. */
export function blockReason(state: ImagePanelState, text: string, emptyTextReason: string): string | null {
  if (state.settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (state.settings.imageModel === '')
    return 'No image model selected — pick a model in Settings.';
  if (state.limitsError !== null) return `Model limits failed to load: ${state.limitsError}`;
  if (state.limits === null) return 'Loading model limits…';
  if (text.trim() === '') return emptyTextReason;
  return null;
}
