import { readFileSync } from 'node:fs';

/** The trimmed REAL /models fixture (13 entries from the live snapshot). */
export function modelsFixture(): { data: { id: string }[] } {
  return JSON.parse(readFileSync('tests/fixtures/models-trimmed.json', 'utf8')) as {
    data: { id: string }[];
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
