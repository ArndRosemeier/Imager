import { useModelList, type ModelListState } from '@/features/settings/useModelList';
import { listVideoModels, type VideoModel } from '@/llm/video';

/** The two loads the Videos tab needs: settings and `GET /videos/models`. */
export type VideoPanelState = ModelListState<VideoModel>;

export function useVideoPanel(): { state: VideoPanelState | null; error: Error | null } {
  return useModelList(listVideoModels, 'OpenRouter video-model list');
}

/**
 * The model a video is made with: the tab's own pick, or — when the owner left
 * the tab's selector on "Default" (`null`) — the Settings pick. `''` is still
 * "no model"; nothing is substituted (docs/17 row 64).
 */
export function videoModelId(state: VideoPanelState, choice: string | null): string {
  return choice ?? state.settings.videoModel;
}

/** The model with that id, once the list has it. */
export function selectedVideoModel(state: VideoPanelState, modelId: string): VideoModel | undefined {
  return state.models?.find((m) => m.id === modelId);
}

/**
 * The models the owner has made videos with, most recent first, each once —
 * read from the stored videos and jobs themselves, so the "recently used" list
 * needs no store of its own and is exactly what was really used.
 */
export function recentVideoModelIds(
  rows: readonly { request: { model: string }; createdAt: number }[],
): string[] {
  const newestFirst = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  return [...new Set(newestFirst.map((row) => row.request.model))];
}

/** Why no video may be generated, or null. There is no fallback model. */
export function videoBlockReason(
  state: VideoPanelState,
  modelId: string,
  prompt: string,
): string | null {
  if (state.settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (modelId === '') return 'No video model selected — pick one above, or a default in Settings.';
  if (state.modelsError !== null) return `Video-model list failed to load: ${state.modelsError}`;
  if (state.models === null) return 'Loading the video-model list…';
  if (selectedVideoModel(state, modelId) === undefined) {
    return `The video model “${modelId}” is not in the current video-model list — pick another.`;
  }
  if (prompt.trim() === '') return 'Describe the video.';
  return null;
}
