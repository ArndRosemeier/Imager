import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OpenRouterError } from '@/llm/errors';
import { canSynthesizeSpeech, voicesOf, type OpenRouterModel } from '@/llm/models';
import { synthesizeSpeech } from '@/llm/speech';
import { jsonResponse } from '../helpers';

/**
 * The speech seam (docs/17 row 60): `POST /audio/speech` answers RAW audio
 * bytes; the app always asks for mp3 (the API's default is unplayable PCM).
 */
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 1]);

let calls: { url: string; init: RequestInit | undefined }[] = [];

function answer(response: () => Response): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response());
  });
}

function bodyOf(index: number): string {
  const body = calls[index]?.init?.body;
  return typeof body === 'string' ? body : '';
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const base = { apiKey: 'sk', model: 'elevenlabs/eleven-v4', input: 'Hello there', retryBackoffs: [] };

it('sends model, input and mp3, plus voice and instructions only when set', async () => {
  answer(() => new Response(MP3, { headers: { 'X-Generation-Id': 'gen-1' } }));
  const result = await synthesizeSpeech({ ...base, voice: 'george', instructions: 'slowly' });
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/speech');
  expect(JSON.parse(bodyOf(0))).toEqual({
    model: 'elevenlabs/eleven-v4',
    input: 'Hello there',
    response_format: 'mp3',
    voice: 'george',
    instructions: 'slowly',
  });
  expect(result).toEqual({ bytes: MP3, mimeType: 'audio/mpeg', generationId: 'gen-1' });

  await synthesizeSpeech({ ...base, voice: null, instructions: null });
  expect(JSON.parse(bodyOf(1))).toEqual({
    model: 'elevenlabs/eleven-v4',
    input: 'Hello there',
    response_format: 'mp3',
  });
});

it('an empty answer and bytes that are not audio both fail loudly', async () => {
  answer(() => new Response(new Uint8Array([])));
  await expect(synthesizeSpeech({ ...base, voice: null, instructions: null })).rejects.toThrow(
    /carried no audio/,
  );
  // Raw PCM (what the API returns when mp3 is ignored) has no signature.
  answer(() => new Response(new Uint8Array([1, 2, 3, 4, 5, 6])));
  await expect(synthesizeSpeech({ ...base, voice: null, instructions: null })).rejects.toThrow(
    /not audio/,
  );
});

it('an error answer is a typed OpenRouterError, never a clip', async () => {
  answer(() => jsonResponse({ error: { message: 'voice is required' } }, 400));
  await expect(
    synthesizeSpeech({ ...base, voice: null, instructions: null }),
  ).rejects.toBeInstanceOf(OpenRouterError);
});

it('speech models are read from the `speech` output modality, voices from supported_voices', () => {
  const tts = {
    id: 'elevenlabs/eleven-v4',
    name: 'Eleven v4',
    architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
    supported_parameters: [],
    pricing: { prompt: '0.00004' },
    supported_voices: ['george', 'sarah'],
  } satisfies OpenRouterModel;
  const chat = {
    ...tts,
    id: 'openai/gpt-audio',
    architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] },
    supported_voices: undefined,
  } satisfies OpenRouterModel;
  expect(canSynthesizeSpeech(tts)).toBe(true);
  expect(canSynthesizeSpeech(chat)).toBe(false);
  expect(voicesOf(tts)).toEqual(['george', 'sarah']);
  expect(voicesOf(chat)).toEqual([]);
});
