import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

// Rule 4: ONE transport seam. A second `fetch(` in src/ is a second client.
it('exactly one fetch( in src/, inside the client seam', () => {
  const hits = sourceFiles('src').flatMap((f) => {
    const n = readFileSync(f, 'utf8').split(/\bfetch\(/).length - 1;
    return Array(n).fill(f) as string[];
  });
  expect(hits).toEqual(['src/llm/client.ts']);
});

// Owner decision (docs/17 row 1b): the app never picks a model. No
// `vendor/model`-shaped string literal may appear in src/ (import
// specifiers start with '@' or '.', and are excluded).
it('no model id literal appears in src/', () => {
  const offenders = sourceFiles('src').flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/['"`]([a-z0-9][\w.-]*\/[\w.:-]+)['"`]/g)]
      .map((m) => `${f}: ${m[1] ?? ''}`)
      // Non-model literals of the same shape, named one by one.
      .filter((s) => !/: (application\/json|vite\/client|react-dom\/client)$/.test(s)),
  );
  expect(offenders).toEqual([]);
});
