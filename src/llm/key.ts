import { z } from 'zod';

import { fetchWithRetries, openRouterHeaders, readJson } from '@/llm/client';
import { MissingApiKeyError } from '@/llm/errors';

/**
 * Key validation via OpenRouter's documented `GET /key` ("Get current API
 * key", https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.md):
 * 200 → `{ data: { label, limit_remaining, usage, … } }`, 401 → invalid key.
 *
 * A 200 is NOT proof the key can generate: a management key and an expired
 * key both describe themselves here, then every generation call answers
 * 401 "User not found." — so the test refuses both by name.
 */
const keyResponseSchema = z.looseObject({
  data: z.looseObject({
    label: z.string(),
    limit_remaining: z.number().nullable(),
    usage: z.number(),
    // Both documented; optional so an account the API answers without them
    // still tests (they only ADD a refusal, never stand in for data).
    is_management_key: z.boolean().optional(),
    expires_at: z.string().nullish(),
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
  const info = (await readJson(response, keyResponseSchema)).data;
  if (info.is_management_key === true) {
    throw new Error(
      'This is a management key: OpenRouter only lets it manage keys, not generate. Create a normal API key at openrouter.ai/settings/keys.',
    );
  }
  if (info.expires_at != null && Date.parse(info.expires_at) <= Date.now()) {
    throw new Error(
      `This key expired on ${info.expires_at}. Create a new API key at openrouter.ai/settings/keys.`,
    );
  }
  return info;
}
