import { afterEach, expect, it, vi } from 'vitest';

import { MissingApiKeyError, OpenRouterError } from '@/llm/errors';
import { renderMusic } from '@/llm/music';
import { base64FromBytes } from '@/lib/base64';

const MODEL = 'google/lyria-3-pro-preview';
/** An MP3 as far as any signature check can tell: an ID3 tag, then payload. */
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const WAV = new TextEncoder().encode('RIFF\x00\x00\x00\x00WAVEfmt payload');

let requests: { url: string; body: string }[] = [];

/** A streamed 200 whose body arrives in the given raw text pieces. */
function sse(pieces: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stub(response: () => Response): void {
  requests = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    return Promise.resolve(response());
  });
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function audioEvents(bytes: Uint8Array<ArrayBuffer>, transcript: string[]): string[] {
  const b64 = base64FromBytes(bytes);
  // Split the base64 at a place that is NOT a multiple of 4: pieces must be
  // concatenated before decoding, never decoded one by one.
  const cut = 5;
  return [
    ': OPENROUTER PROCESSING\n\n',
    event({ model: MODEL, choices: [{ delta: { audio: { data: b64.slice(0, cut), transcript: transcript[0] } } }] }),
    event({ choices: [{ delta: { audio: { data: b64.slice(cut), transcript: transcript[1] } } }] }),
    event({ choices: [{ delta: { content: 'Here is your song.' } }], usage: { cost: 0.08 } }),
    'data: [DONE]\n\n',
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('posts the documented audio-output body and assembles the streamed song', async () => {
  stub(() => sse(audioEvents(new Uint8Array(MP3), ['[Verse]\nla ', 'la'])));
  const result = await renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'Style: synthwave' });

  expect(requests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
    model: MODEL,
    messages: [{ role: 'user', content: 'Style: synthwave' }],
    modalities: ['text', 'audio'],
    audio: { format: 'mp3' },
    stream: true,
  });
  expect([...result.bytes]).toEqual([...MP3]);
  expect(result.mimeType).toBe('audio/mpeg');
  expect(result.transcript).toBe('[Verse]\nla la');
  expect(result.text).toBe('Here is your song.');
  expect(result.model).toBe(MODEL);
  expect(result.costUsd).toBe(0.08);
});

it('reads events split across arbitrary network chunks (mid-line, mid-JSON)', async () => {
  const whole = audioEvents(new Uint8Array(MP3), ['a', 'b']).join('');
  const pieces: string[] = [];
  for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));
  stub(() => sse(pieces));
  const result = await renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' });
  expect([...result.bytes]).toEqual([...MP3]);
  expect(result.transcript).toBe('ab');
});

it('records the format the bytes ARE (WAV answered to an MP3 request)', async () => {
  stub(() => sse(audioEvents(new Uint8Array(WAV), ['', ''])));
  const result = await renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' });
  expect(result.mimeType).toBe('audio/wav');
});

it('a mid-stream error envelope is a loud typed error, not a short song', async () => {
  stub(() =>
    sse([
      event({ choices: [{ delta: { audio: { data: base64FromBytes(new Uint8Array(MP3)) } } }] }),
      event({ error: { code: 502, message: 'Provider returned error' } }),
      'data: [DONE]\n\n',
    ]),
  );
  const error: unknown = await renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpenRouterError);
  expect((error as Error).message).toContain('Provider returned error');
});

it('a stream that ends without [DONE] is refused as truncated', async () => {
  stub(() => sse(audioEvents(new Uint8Array(MP3), ['', '']).slice(0, 3)));
  await expect(renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' })).rejects.toThrow(
    /ended before it was complete/,
  );
});

it('a stream with no audio, or with bytes in no known format, throws', async () => {
  stub(() => sse([event({ choices: [{ delta: { content: 'I cannot.' } }] }), 'data: [DONE]\n\n']));
  await expect(renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' })).rejects.toThrow(
    /carried no audio/,
  );
  stub(() => sse(audioEvents(new TextEncoder().encode('not audio at all'), ['', ''])));
  await expect(renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' })).rejects.toThrow(
    /no format this app recognises/,
  );
});

it('a non-JSON event is a loud invalid-response', async () => {
  stub(() => sse(['data: {not json\n\n', 'data: [DONE]\n\n']));
  const error: unknown = await renderMusic({ apiKey: 'sk', model: MODEL, prompt: 'p' }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpenRouterError);
  expect((error as OpenRouterError).kind).toBe('invalid-response');
});

it('no key → MissingApiKeyError before any request', async () => {
  stub(() => sse([]));
  await expect(renderMusic({ apiKey: '', model: MODEL, prompt: 'p' })).rejects.toBeInstanceOf(
    MissingApiKeyError,
  );
  expect(requests).toHaveLength(0);
});
