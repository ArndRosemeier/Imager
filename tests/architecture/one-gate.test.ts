import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// The gate is ONE script (AGENTS.md §The gate and the clock): a second
// suite-runner would split the "one suite at a time" lock discipline, so it
// must go red here rather than drift in quietly.
it('keeps scripts/gate.sh the exactly-one suite runner', () => {
  const entries = readdirSync('scripts', { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
    .map((entry) => entry.name)
    .sort();
  expect(entries).toEqual(['gate.sh']);

  // And no source or test file hand-rolls a suite run of its own: the only
  // place the words `vitest run` may appear is the gate, its pin, and docs.
  const offenders: string[] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(file);
      } else if (/\.(ts|tsx|sh)$/.test(file)) {
        if (file.endsWith('tests/architecture/one-gate.test.ts')) continue;
        const content = readFileSync(file, 'utf8');
        if (content.includes('vitest run')) offenders.push(file);
      }
    }
  }
  walk('src');
  walk('tests');
  walk('scripts');
  expect(offenders).toEqual(['scripts/gate.sh']);
});
