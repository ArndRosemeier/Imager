import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

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

// Slice 3: ONE image request shape. The body of a reference entry
// (`image_url.url`) is built in exactly one place — a second consumer that
// assembled its own entry could send a differently-shaped reference.
it('the reference entry body is built in exactly one src/ file', () => {
  const hits = sourceFiles('src').filter((f) =>
    readFileSync(f, 'utf8').includes('image_url: { url:'),
  );
  expect(hits).toEqual(['src/llm/images.ts']);
});
