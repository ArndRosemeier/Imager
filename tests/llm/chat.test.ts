import { afterEach, expect, it, vi } from 'vitest';

import { chatCompletion, type ChatTurnMessage } from '@/llm/chat';
import { MissingApiKeyError, OpenRouterError } from '@/llm/errors';
import { jsonResponse } from '../helpers';

const DATA_URL = `data:image/png;base64,${btoa('png-bytes')}`;
const MODEL = 'google/gemini-2.5-flash-image';
let requests: { url: string; body: string }[] = [];

function stubChat(body: () => Response): void {
  requests = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    return Promise.resolve(body());
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('a USER message with an attached image sends multimodal content parts', async () => {
  stubChat(() =>
    jsonResponse({
      model: MODEL,
      choices: [{ message: { role: 'assistant', content: 'Changed the sky.', images: [{ image_url: { url: DATA_URL } }] } }],
      usage: { cost: 0.1 },
    }),
  );
  // The owner's "have an image as the base of the chat": a user turn that
  // CARRIES an image. Before ledger row 16 this branch returned
  // `content: text` and the image was silently dropped.
  const messages: ChatTurnMessage[] = [
    { role: 'user', text: 'start from this', imageDataUrls: [DATA_URL] },
  ];
  await chatCompletion({ apiKey: 'sk', model: MODEL, messages });

  const body = JSON.parse(requests[0]?.body ?? '') as { messages: unknown[] };
  expect(body.messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'start from this' },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ],
    },
  ]);
});

it('an image-only user message sends the image part and no empty text part', async () => {
  stubChat(() =>
    jsonResponse({
      model: MODEL,
      choices: [{ message: { role: 'assistant', content: 'ok', images: [] } }],
    }),
  );
  await chatCompletion({
    apiKey: 'sk',
    model: MODEL,
    messages: [{ role: 'user', text: '', imageDataUrls: [DATA_URL] }],
  });
  const body = JSON.parse(requests[0]?.body ?? '') as { messages: unknown[] };
  expect(body.messages).toEqual([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: DATA_URL } }] },
  ]);
});

it('a user message with NO image stays a plain string', async () => {
  stubChat(() =>
    jsonResponse({ model: MODEL, choices: [{ message: { role: 'assistant', content: 'ok', images: [] } }] }),
  );
  await chatCompletion({ apiKey: 'sk', model: MODEL, messages: [{ role: 'user', text: 'hello' }] });
  const body = JSON.parse(requests[0]?.body ?? '') as { messages: unknown[] };
  expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
});

it('posts modalities + the messages in order and returns text, image bytes and cost', async () => {
  stubChat(() =>
    jsonResponse({
      model: MODEL,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Here it is, with a darker sky.',
            images: [{ image_url: { url: DATA_URL } }],
          },
        },
      ],
      usage: { cost: 0.42, total_tokens: 10 },
    }),
  );
  const messages: ChatTurnMessage[] = [
    { role: 'user', text: 'make the sky darker' },
    { role: 'assistant', text: 'Done.', imageDataUrls: [DATA_URL] },
    { role: 'user', text: 'now add rain' },
  ];
  const result = await chatCompletion({ apiKey: 'sk', model: MODEL, messages });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  const body = JSON.parse(requests[0]?.body ?? '') as {
    model: string;
    modalities: string[];
    messages: unknown[];
  };
  expect(body.model).toBe(MODEL);
  // The pin: the output modalities of a chat-refinement turn.
  expect(body.modalities).toEqual(['text', 'image']);
  expect(body.messages).toEqual([
    { role: 'user', content: 'make the sky darker' },
    {
      role: 'assistant',
      content: 'Done.',
      images: [{ type: 'image_url', image_url: { url: DATA_URL } }],
    },
    { role: 'user', content: 'now add rain' },
  ]);

  expect(result.text).toBe('Here it is, with a darker sky.');
  expect(result.images).toHaveLength(1);
  expect(result.images[0]?.mimeType).toBe('image/png');
  expect([...(result.images[0]?.bytes ?? [])]).toEqual([
    ...new TextEncoder().encode('png-bytes'),
  ]);
  expect(result.model).toBe(MODEL);
  expect(result.costUsd).toBe(0.42);
});

it('sends image_config when given, and accepts content returned as parts', async () => {
  stubChat(() =>
    jsonResponse({
      choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }],
    }),
  );
  const result = await chatCompletion({
    apiKey: 'sk',
    model: MODEL,
    messages: [{ role: 'user', text: 'hi' }],
    imageConfig: { aspect_ratio: '16:9', quality: 'high' },
  });
  expect(JSON.parse(requests[0]?.body ?? '')).toMatchObject({
    image_config: { aspect_ratio: '16:9', quality: 'high' },
  });
  expect(result.text).toBe('ok');
  expect(result.images).toEqual([]);
});

it('an image-only answer is a valid result (text may be empty)', async () => {
  stubChat(() =>
    jsonResponse({
      choices: [{ message: { role: 'assistant', content: null, images: [{ image_url: { url: DATA_URL } }] } }],
    }),
  );
  const result = await chatCompletion({
    apiKey: 'sk',
    model: MODEL,
    messages: [{ role: 'user', text: 'hi' }],
  });
  expect(result.text).toBe('');
  expect(result.images).toHaveLength(1);
});

it('a 200 error envelope is a loud typed error, not a result', async () => {
  stubChat(() => jsonResponse({ error: { code: 400, message: 'Prompt was refused' } }));
  const error: unknown = await chatCompletion({
    apiKey: 'sk',
    model: MODEL,
    messages: [{ role: 'user', text: 'hi' }],
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpenRouterError);
  expect((error as OpenRouterError).kind).toBe('http');
  expect((error as OpenRouterError).bodyText).toMatch(/Prompt was refused/);
});

it('a completion with neither text nor images is a loud failure, never an empty success', async () => {
  stubChat(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: '  ' } }] }));
  const error: unknown = await chatCompletion({
    apiKey: 'sk',
    model: MODEL,
    messages: [{ role: 'user', text: 'hi' }],
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpenRouterError);
  expect((error as OpenRouterError).kind).toBe('invalid-response');
  expect((error as OpenRouterError).bodyText).toMatch(/neither text nor images/);
});

it('an image that is not a base64 data URL is a loud boundary failure', async () => {
  stubChat(() =>
    jsonResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'x',
            images: [{ image_url: { url: 'https://example.com/a.png' } }],
          },
        },
      ],
    }),
  );
  const error: unknown = await chatCompletion({
    apiKey: 'sk',
    model: MODEL,
    messages: [{ role: 'user', text: 'hi' }],
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpenRouterError);
  expect((error as OpenRouterError).kind).toBe('invalid-response');
  expect((error as OpenRouterError).bodyText).toMatch(/not a data: URL/);
});

it('no API key → MissingApiKeyError and no request', async () => {
  stubChat(() => jsonResponse({}));
  const error: unknown = await chatCompletion({
    apiKey: '',
    model: MODEL,
    messages: [{ role: 'user', text: 'hi' }],
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MissingApiKeyError);
  expect(requests).toEqual([]);
});
