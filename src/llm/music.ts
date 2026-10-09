/**
 * THE music-render seam (docs/17 row 52): one song from one prompt, through
 * `POST /chat/completions` with AUDIO output. It is the streamed sibling of
 * `src/llm/chat.ts` (same endpoint, different response mode) and goes through
 * the same transport, including the ONE SSE reader (`readSseData`).
 *
 * MEASURED 2026-10-09 (the research behind this slice, docs/17 row 52):
 *   - OpenRouter documents audio output as `modalities: ["text","audio"]` plus
 *     `audio: { format }`, and audio output REQUIRES `stream: true`; each SSE
 *     chunk carries `choices[0].delta.audio.data` (base64 pieces that are
 *     concatenated) and `delta.audio.transcript` (for Lyria: the lyrics);
 *   - a working third-party client (OpenClaw's OpenRouter music provider) sends
 *     exactly this body to `google/lyria-3-*-preview` with `format` mp3|wav;
 *   - Lyria takes TEXT (and images) in, never audio: a song cannot be sent back
 *     to be edited or extended. Every render is a fresh take of its prompt —
 *     refinement happens on the song SHEET (`src/domain/music.ts`), not here.
 *
 * Every failure is LOUD: a mid-stream error envelope, a stream without
 * `[DONE]`, no audio at all, base64 that does not decode, and bytes in no known
 * audio format all throw. No partial song is ever returned.
 */
import { z } from 'zod';

import {
  IMAGE_RENDER_HEADERS_TIMEOUT_MS,
  fetchWithRetries,
  openRouterHeaders,
  readSseData,
} from '@/llm/client';
import { MissingApiKeyError, OpenRouterError, parseOpenRouterErrorEnvelope } from '@/llm/errors';
import { AUDIO_FORMATS, sniffAudioFormat } from '@/lib/audioFormat';
import { bytesFromBase64 } from '@/lib/base64';

/**
 * The container the app asks for. MP3: Lyria Clip produces MP3 only (Gemini
 * docs), and a three-minute 48 kHz stereo WAV is tens of megabytes in
 * IndexedDB. A product decision, recorded in docs/17 row 52 — not a fallback.
 */
export const MUSIC_FORMAT = AUDIO_FORMATS.mp3;

export interface MusicRequest {
  apiKey: string;
  model: string;
  /** The whole render prompt, built by `renderPrompt` from the song sheet. */
  prompt: string;
  signal?: AbortSignal | undefined;
  retryBackoffs?: readonly number[];
}

export interface MusicResult {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** `delta.audio.transcript`, joined: the lyrics as the model sang them. */
  transcript: string;
  /** `delta.content`, joined: any text the model answered alongside. */
  text: string;
  /** The model the stream names; the request's model when it names none. */
  model: string;
  costUsd: number | null;
}

const chunkSchema = z.looseObject({
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            audio: z
              .looseObject({ data: z.string().nullish(), transcript: z.string().nullish() })
              .nullish(),
          })
          .nullish(),
      }),
    )
    .optional(),
  usage: z.looseObject({ cost: z.number().nullish() }).nullish(),
});

/** One rendered song. See the module header for every loud failure. */
export async function renderMusic(req: MusicRequest): Promise<MusicResult> {
  if (req.apiKey === '') throw new MissingApiKeyError();
  const response = await fetchWithRetries(
    '/chat/completions',
    {
      method: 'POST',
      headers: openRouterHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: 'user', content: req.prompt }],
        modalities: ['text', 'audio'],
        audio: { format: MUSIC_FORMAT.name },
        stream: true,
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    },
    req.retryBackoffs,
    IMAGE_RENDER_HEADERS_TIMEOUT_MS,
  );

  let audioBase64 = '';
  let transcript = '';
  let text = '';
  let model: string | undefined;
  let costUsd: number | null = null;
  for await (const payload of readSseData(response)) {
    const envelope = parseOpenRouterErrorEnvelope(payload);
    if (envelope !== null) {
      throw new OpenRouterError(
        'http',
        response.status,
        envelope.message ?? 'the music stream reported an error',
        envelope.errorType ?? envelope.code,
      );
    }
    const parsed = chunkSchema.safeParse(payload);
    if (!parsed.success) {
      throw new OpenRouterError('invalid-response', response.status, parsed.error.message);
    }
    const delta = parsed.data.choices?.[0]?.delta;
    audioBase64 += delta?.audio?.data ?? '';
    transcript += delta?.audio?.transcript ?? '';
    text += delta?.content ?? '';
    model = parsed.data.model ?? model;
    costUsd = parsed.data.usage?.cost ?? costUsd;
  }

  if (audioBase64 === '') {
    throw new OpenRouterError('invalid-response', response.status, 'the music stream carried no audio');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = bytesFromBase64(audioBase64);
  } catch (error) {
    throw new OpenRouterError(
      'invalid-response',
      response.status,
      `the music stream's audio is not valid base64 (${String(error)})`,
    );
  }
  // The stored type is what the bytes ARE, read from their signature — never
  // the format that was asked for. A provider answering WAV to an MP3 request
  // still yields a correctly typed, playable song (the money is spent); bytes
  // in no known format throw.
  const format = sniffAudioFormat(bytes);
  return { bytes, mimeType: format.mimeType, transcript, text, model: model ?? req.model, costUsd };
}
