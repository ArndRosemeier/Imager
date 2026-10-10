import {
  acceptsImageInput,
  canGenerateAudio,
  canGenerateImages,
  canRefineViaChat,
  canSynthesizeSpeech,
  canWriteSongSheet,
  voicesOf,
  type OpenRouterModel,
} from '@/llm/models';
import {
  acceptsFirstFrame,
  acceptsLastFrame,
  canGenerateVideoAudio,
  type VideoModel,
} from '@/llm/video';

/**
 * One row of the picker, whatever list it came from: the general `GET /models`
 * list or the video list (`GET /videos/models`), which has its own shape.
 */
export interface ModelOption {
  id: string;
  name: string;
  /** The price line, as the API states it. */
  price: string;
  /** What the model can do, read from a capability seam — never from its id. */
  badges: string[];
}

/** Prices are USD-per-unit decimal strings; show them as given, per unit. */
function priceSummary(model: OpenRouterModel): string {
  const parts: string[] = [];
  for (const key of ['prompt', 'completion', 'image', 'image_output', 'audio_output'] as const) {
    const value = model.pricing[key];
    if (typeof value === 'string')
      parts.push(`${key} ${value === '-1' ? 'variable' : `$${value}`}`);
  }
  return parts.length === 0 ? 'price n/a' : parts.join(' · ');
}

/** A `GET /models` entry as a picker row. */
export function openRouterOption(model: OpenRouterModel): ModelOption {
  return { id: model.id, name: model.name, price: priceSummary(model), badges: badges(model) };
}

/**
 * A video model as a picker row: its pricing SKUs as given (USD decimal
 * strings, keys such as a per-second rate), and its limits as badges.
 */
export function videoOption(model: VideoModel): ModelOption {
  const skus = Object.entries(model.pricing_skus ?? {}).map(([key, value]) => `${key} $${value}`);
  const out: string[] = [];
  if (model.supported_durations !== null && model.supported_durations.length > 0) {
    out.push(`${model.supported_durations.join('/')} s`);
  }
  if (model.supported_resolutions !== null && model.supported_resolutions.length > 0) {
    out.push(model.supported_resolutions.join('/'));
  }
  if (acceptsFirstFrame(model)) out.push('start image');
  if (acceptsLastFrame(model)) out.push('end image');
  if (canGenerateVideoAudio(model)) out.push('audio');
  return {
    id: model.id,
    name: model.name,
    price: skus.length === 0 ? 'price n/a' : skus.join(' · '),
    badges: out,
  };
}

/** What the model can do, read from the capability seam — never from its id. */
function badges(model: OpenRouterModel): string[] {
  const out: string[] = [];
  if (canGenerateImages(model)) out.push('image out');
  if (canGenerateAudio(model)) out.push('audio out');
  if (canSynthesizeSpeech(model)) out.push('speech out');
  if (voicesOf(model).length > 0) out.push(`${String(voicesOf(model).length)} voices`);
  if (canWriteSongSheet(model)) out.push('structured text');
  if (acceptsImageInput(model)) out.push('image in');
  if (canRefineViaChat(model))
    out.push('chat refine');
  return out;
}

