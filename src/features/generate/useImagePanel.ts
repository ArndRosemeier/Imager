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
  /**
   * The model a REFINEMENT runs with (owner, ledger row 11): the dedicated
   * refinement model when the owner picked one, else the image model. The
   * fallback is not a silent substitution of a MODEL — an empty refinement
   * pick means "use the model I chose for images", which is a real
   * owner-visible state (the panel names the model it will send).
   */
  refineModel: string;
  /** The refinement model's published limits (equals `limits` when the same). */
  refineLimits: ImageModelLimits | null;
  refineLimitsError: string | null;
}

/** The model a refinement sends: the owner's refinement pick, else the image model. */
export function refineModelFor(settings: Settings): string {
  return settings.refineChatModel === '' ? settings.imageModel : settings.refineChatModel;
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
        const refineModel = refineModelFor(settings);
        setState({
          settings,
          limits: null,
          limitsError: null,
          refineModel,
          refineLimits: null,
          refineLimitsError: null,
        });
        // ONE fetch of the published limits, then read BOTH models out of it
        // (never two requests for two picks).
        if (settings.imageModel === '' && refineModel === '') return;
        listImageModelLimits(settings.openRouterApiKey).then(
          (all) => {
            if (cancelled) return;
            setState((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    limits: settings.imageModel === '' ? null : limitsFor(all, settings.imageModel),
                    refineLimits: refineModel === '' ? null : limitsFor(all, refineModel),
                  },
            );
          },
          (limitError: unknown) => {
            if (cancelled) return;
            const message = errorMessage(limitError);
            setState((prev) =>
              prev === null
                ? prev
                : { ...prev, limitsError: message, refineLimitsError: message },
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

/**
 * The refine form's disabled reason: `blockReason` against the REFINEMENT
 * model's own limits (owner, ledger row 11) — an empty refinement pick is not
 * a blocker, it falls back to the image model by `refineModelFor`.
 */
export function refineBlockReason(state: ImagePanelState, instruction: string): string | null {
  if (state.refineModel === '') return 'No refinement model selected — pick one in Settings.';
  return blockReason(
    { ...state, limits: state.refineLimits, limitsError: state.refineLimitsError },
    instruction,
    'Enter an instruction for the refinement.',
  );
}
