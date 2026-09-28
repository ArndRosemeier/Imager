import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * Rule 4: ONE transport seam PER SERVICE. A third `fetch(` in src/ is a third
 * client, and an unnamed one is worse: the next reader cannot tell which
 * service a request is going to.
 *
 * THE TWO AUTHORISED SEAMS (docs/17 row 42):
 *  * `src/llm/client.ts` — OpenRouter.
 *  * `src/server/store-client.ts` — the ServerStore (`store.futuremagic.de`).
 *
 * The ServerStore seam is NOT folded into the OpenRouter one on purpose: the
 * two share nothing but the word "fetch" (different auth, error envelope,
 * retry policy and body type), so one function would have to branch on which
 * service it is talking to.
 */
const AUTHORISED_FETCH_SITES = ['src/llm/client.ts', 'src/server/store-client.ts'];

it('exactly the two NAMED fetch( sites exist in src/', () => {
  const hits = sourceFiles('src').flatMap((f) => {
    const n = readFileSync(f, 'utf8').split(/\bfetch\(/).length - 1;
    return Array(n).fill(f) as string[];
  });
  expect([...new Set(hits)].sort()).toEqual([...AUTHORISED_FETCH_SITES].sort());
});

// Owner decision (docs/17 row 1b): the app never picks a model. No
// `vendor/model`-shaped string literal may appear in src/ (import
// specifiers start with '@' or '.', and are excluded).
it('no model id literal appears in src/', () => {
  const offenders = sourceFiles('src').flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/['"`]([a-z0-9][\w.-]*\/[\w.:-]+)['"`]/g)]
      .map((m) => `${f}: ${m[1] ?? ''}`)
      /**
       * Non-model literals of the same shape, named one by one. The MIME types
       * are the ServerStore slice's (docs/17 row 42): they are CONTRACTUAL
       * media types, not model ids, and the allow-list stays explicit so a new
       * `vendor/model` string still fails this pin.
       */
      .filter(
        (s) =>
          !/: (application\/json|application\/zip|application\/octet-stream|image\/webp|image\/png|image\/jpeg|image\/avif|vite\/client|react-dom\/client)$/.test(
            s,
          ),
      ),
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
