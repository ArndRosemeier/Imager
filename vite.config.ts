import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The worker budget a test run uses when nothing says otherwise.
 *
 * TWO, and that is deliberate (see AGENTS.md §Host hygiene): a resource bound
 * that depends on every writer REMEMBERING an environment variable is not a
 * bound. With this default, `pnpm exec vitest run` cannot exceed two workers
 * whatever anyone forgets; raising it is an explicit act by whoever owns the
 * machine's load. The bound lives in the config, and the config default IS
 * the bound.
 */
export const DEFAULT_TEST_WORKERS = 2;

/**
 * The worker budget for a test run — the ONE bound that actually binds.
 *
 *   IMAGER_TEST_WORKERS=4 pnpm exec vitest run
 *
 * A value that is present but not a positive integer is a loud error rather
 * than a silent fallback.
 */
export function testMaxWorkers(): number {
  const raw = process.env.IMAGER_TEST_WORKERS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_TEST_WORKERS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `IMAGER_TEST_WORKERS must be a positive integer (got "${raw}") — ` +
        `unset it to use the default of ${String(DEFAULT_TEST_WORKERS)}.`,
    );
  }
  return parsed;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // A TEST RUN MUST NOT BE AT THE MERCY OF AN AMBIENT NODE_ENV. Vitest sets
  // NODE_ENV to 'test' only when it is UNSET, so a harness or container that
  // exports NODE_ENV=production leaks straight in: React resolves its
  // production build ("act(...) is not supported in production builds of
  // React") and `node:` built-ins imported by a test fail. Forcing it here
  // covers EVERY entry point (the gate, a bare `pnpm exec vitest run`, and
  // `pnpm test`) instead of one command, and `mode === 'test'` keeps
  // `vite build`/`vite dev` on their real NODE_ENV.
  if (mode === 'test') process.env.NODE_ENV = 'test';

  return {
    // The future publish subpath (static host serves Imager under
    // https://apps.futuremagic.de/imager/). The dev server is unaffected.
    base: '/imager/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // Default: serve only files inside the project root. Stated explicitly
      // so a future widening is a visible, reviewable choice.
      fs: {
        strict: true,
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['tests/setup.ts'],
      css: false,
      // The config default IS the bound (AGENTS.md §Host hygiene): the bare
      // `pnpm exec vitest run` cannot exceed two workers.
      maxWorkers: testMaxWorkers(),
      testTimeout: 20_000,
    },
  };
});
