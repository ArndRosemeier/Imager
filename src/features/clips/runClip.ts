import { putClip } from '@/db/clipRepo';
import type { ClipKind, ClipRequest, StoredClip } from '@/domain/clip';
import type { ChatPanelState } from '@/features/chat/useChat';
import { canSynthesizeSpeech, type OpenRouterModel } from '@/llm/models';
import { synthesizeSpeech } from '@/llm/speech';

/** The settings field each tab renders with (docs/17 row 60). */
export const CLIP_MODEL_SETTING = { sound: 'soundModel', voice: 'voiceModel' } as const;

/** The picked model for a tab, once the list has it. */
export function selectedClipModel(state: ChatPanelState, kind: ClipKind): OpenRouterModel | undefined {
  const id = state.settings[CLIP_MODEL_SETTING[kind]];
  return state.models?.find((m) => m.id === id);
}

/** Why no clip may be made, or null. There is no fallback model. */
export function clipBlockReason(state: ChatPanelState, kind: ClipKind, text: string): string | null {
  const id = state.settings[CLIP_MODEL_SETTING[kind]];
  const noun = kind === 'sound' ? 'sound' : 'voice';
  if (state.settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (id === '') return `No ${noun} model selected — pick one in Settings.`;
  if (state.modelsError !== null) return `Model list failed to load: ${state.modelsError}`;
  if (state.models === null) return 'Loading the model list…';
  const model = selectedClipModel(state, kind);
  if (model === undefined) {
    return `The ${noun} model “${id}” is not in the current model list — pick another in Settings.`;
  }
  if (!canSynthesizeSpeech(model)) {
    return `The ${noun} model “${id}” does not produce speech audio — pick another in Settings.`;
  }
  if (text.trim() === '') return kind === 'sound' ? 'Describe the sound.' : 'Enter the text to speak.';
  return null;
}

/**
 * Render one clip and STORE it. The clip is saved here, not by the tab, so a
 * render that finishes after the owner switched tabs is still kept (the money
 * is spent). Any failure propagates to the caller's toast — nothing is stored.
 */
export async function makeClip({
  apiKey,
  kind,
  request,
}: {
  apiKey: string;
  kind: ClipKind;
  request: ClipRequest;
}): Promise<StoredClip> {
  const result = await synthesizeSpeech({
    apiKey,
    model: request.model,
    input: request.text,
    voice: request.voice,
    instructions: request.instructions,
  });
  const clip: StoredClip = {
    id: crypto.randomUUID(),
    kind,
    bytes: result.bytes,
    mimeType: result.mimeType,
    request,
    generationId: result.generationId,
    createdAt: Date.now(),
    // A new clip is untagged until the owner tags it, like a new image.
    tags: [],
  };
  await putClip(clip);
  return clip;
}
