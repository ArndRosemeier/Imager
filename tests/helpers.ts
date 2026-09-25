import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The trimmed REAL /models fixture (13 entries from the live snapshot). */
export function modelsFixture(): { data: { id: string }[] } {
  return JSON.parse(readFileSync('tests/fixtures/models-trimmed.json', 'utf8')) as {
    data: { id: string }[];
  };
}

/**
 * Every `.ts`/`.tsx` file under `dir`, recursively — the ONE source walker for
 * the source-level "exactly one" pins (`tests/architecture/`). Two copies of
 * this walker would let the two pin sets scan different trees.
 */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
