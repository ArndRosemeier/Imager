import { z } from 'zod';

import { fetchWithRetries, openRouterHeaders, readJson } from '@/llm/client';
import { MissingApiKeyError } from '@/llm/errors';

/**
 * Key validation via OpenRouter's documented `GET /key` ("Get current API
 * key", https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.md):
 * 200 → `{ data: { label, limit_remaining, usage, … } }`, 401 → invalid key.
 */
const keyResponseSchema = z.looseObject({
  data: z.looseObject({
    label: z.string(),
    limit_remaining: z.number().nullable(),
    usage: z.number(),
  }),
});

export type KeyInfo = z.infer<typeof keyResponseSchema>['data'];

export async function testApiKey(apiKey: string): Promise<KeyInfo> {
  if (apiKey.trim() === '') throw new MissingApiKeyError();
  // No retries: a key test is interactive, the user retries by clicking.
  const response = await fetchWithRetries(
    '/key',
    { headers: openRouterHeaders(apiKey.trim()) },
    [],
  );
  return (await readJson(response, keyResponseSchema)).data;
}
