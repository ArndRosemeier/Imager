/**
 * THE speech seam (docs/17 row 60): one audio clip from one text, through
 * OpenRouter's OpenAI-compatible `POST /audio/speech`. The Voice tab (speech)
 * and the Sounds tab (sound effects) BOTH go through it — OpenRouter has no
 * separate sound-effects endpoint or model family; a speech model whose prompt
 * may describe sounds (ByteDance Seed Audio 1.0) is the closest it offers.
 *
 * READ 2026-10-10 from OpenRouter's text-to-speech guide
 * (openrouter.ai/docs/guides/overview/multimodal/tts) and the ElevenLabs launch
 * post (openrouter.ai/blog/announcements/elevenlabs-on-openrouter):
 *   - body: `model`, `input` (the text), optional `voice` (provider-dependent;
 *     a provider without a default voice rejects a request without one),
 *     optional `instructions` (delivery guidance — used by OpenAI and Gemini
 *     TTS, ignored by others), `response_format` `mp3` | `pcm` (DEFAULT pcm —
 *     raw samples no browser can play, so mp3 is always asked for);
 *   - a 200 answer is the RAW audio bytes (not JSON), with `X-Generation-Id`;
 *     an error is a JSON body, which the transport already throws on;
 *   - models are the `speech` output modality of `GET /models`, and a model
 *     lists its voices in `supported_voices` (see `src/llm/models.ts`).
 * NOT MEASURED against the live API from this container (openrouter.ai is not
 * reachable from it); the shape above is the documented one.
 *
 * Every failure is LOUD: an empty body and bytes in no known audio format both
 * throw. The stored type is what the bytes ARE (`sniffAudioFormat`).
 */
import { IMAGE_RENDER_HEADERS_TIMEOUT_MS, fetchWithRetries, openRouterHeaders } from '@/llm/client';
import { MissingApiKeyError, OpenRouterError } from '@/llm/errors';
import { AUDIO_FORMATS, sniffAudioFormat } from '@/lib/audioFormat';

/** The container the app asks for: playable everywhere, small in IndexedDB. */
export const SPEECH_FORMAT = AUDIO_FORMATS.mp3;

export interface SpeechRequest {
  apiKey: string;
  model: string;
  /** The text to speak — or, for a sound, the description of the sound. */
  input: string;
  /** A voice the model lists; null = not sent (the model's own default). */
  voice: string | null;
  /** Delivery guidance; null = not sent. */
  instructions: string | null;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
}

export interface SpeechResult {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** OpenRouter's `X-Generation-Id`, when it sent one. */
  generationId: string | null;
}

/** One synthesized clip. See the module header for every loud failure. */
export async function synthesizeSpeech(req: SpeechRequest): Promise<SpeechResult> {
  if (req.apiKey === '') throw new MissingApiKeyError();
  const response = await fetchWithRetries(
    '/audio/speech',
    {
      method: 'POST',
      headers: openRouterHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        input: req.input,
        response_format: SPEECH_FORMAT.name,
        ...(req.voice === null ? {} : { voice: req.voice }),
        ...(req.instructions === null ? {} : { instructions: req.instructions }),
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    },
    req.retryBackoffs,
    // A clip is rendered before the headers arrive (Seed Audio renders up to
    // 120 s of audio), so it takes the render timeout, not the 60 s default.
    IMAGE_RENDER_HEADERS_TIMEOUT_MS,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new OpenRouterError('invalid-response', response.status, 'the speech answer carried no audio');
  }
  let mimeType: string;
  try {
    mimeType = sniffAudioFormat(bytes).mimeType;
  } catch (error) {
    throw new OpenRouterError('invalid-response', response.status, `the speech answer is not audio: ${String(error)}`);
  }
  return { bytes, mimeType, generationId: response.headers.get('X-Generation-Id') };
}
