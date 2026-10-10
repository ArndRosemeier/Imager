import { useModelList, type ModelListState } from '@/features/settings/useModelList';
import { listVideoModels, type VideoModel } from '@/llm/video';

/** The two loads the Videos tab needs: settings and `GET /videos/models`. */
export type VideoPanelState = ModelListState<VideoModel>;

export function useVideoPanel(): { state: VideoPanelState | null; error: Error | null } {
  return useModelList(listVideoModels, 'OpenRouter video-model list');
}

/** The picked video model, once the list has it. */
export function selectedVideoModel(state: VideoPanelState): VideoModel | undefined {
  return state.models?.find((m) => m.id === state.settings.videoModel);
}

/** Why no video may be generated, or null. There is no fallback model. */
export function videoBlockReason(state: VideoPanelState, prompt: string): string | null {
  const model = state.settings.videoModel;
  if (state.settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (model === '') return 'No video model selected — pick one in Settings.';
  if (state.modelsError !== null) return `Video-model list failed to load: ${state.modelsError}`;
  if (state.models === null) return 'Loading the video-model list…';
  if (selectedVideoModel(state) === undefined) {
    return `The video model “${model}” is not in the current video-model list — pick another in Settings.`;
  }
  if (prompt.trim() === '') return 'Describe the video.';
  return null;
}
