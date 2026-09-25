import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * The reference-prep seam's canvas encoding, pinned at the SOURCE level.
 *
 * The live defect (2026-09-25, ledger row 14): `encodeScaled` called
 * `context.canvas.toDataURL(...)` on whichever canvas it got. An
 * `OffscreenCanvas` has NO `toDataURL` — only `HTMLCanvasElement` does — so
 * every refinement of an image larger than the cap threw
 * `r.canvas.toDataURL is not a function` in the production bundle. TypeScript
 * did not catch it because the OffscreenCanvas context was cast to
 * `CanvasRenderingContext2D`. The behavioural pin lives in the panel suites
 * (an honest `convertToBlob`-only double); this file pins the SHAPE that made
 * the mistake possible.
 */
const SOURCE_PATH = 'src/features/refine/reference.ts';
const source = readFileSync(SOURCE_PATH, 'utf8');

/** Comment-stripped source: the pins below are about CODE, not prose. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The text of the function whose body contains `needle`. This slices our OWN
 * structured source, not free text (AGENTS rule 5). */
function holderFunction(needle: string): string {
  const index = code.indexOf(needle);
  expect(index, `${needle} is absent from ${SOURCE_PATH}`).toBeGreaterThan(-1);
  const start = code.lastIndexOf('function ', index);
  const end = code.indexOf('\n}', index);
  return code.slice(start, end);
}

it('an OffscreenCanvas encodes via the async convertToBlob contract, never toDataURL', () => {
  const offscreen = holderFunction('convertToBlob');
  expect(offscreen).toContain('OffscreenCanvas');
  expect(offscreen).not.toContain('toDataURL');
});

it('toDataURL appears ONLY on the HTMLCanvasElement path', () => {
  const hits = code.split('\n').filter((line) => line.includes('toDataURL'));
  expect(hits).toHaveLength(1);
  const html = holderFunction('toDataURL');
  expect(html).toContain('HTMLCanvasElement');
  expect(html).not.toContain('OffscreenCanvas');
});

it('no lying canvas cast hides a missing method', () => {
  // `context as unknown as CanvasRenderingContext2D` is exactly what let the
  // OffscreenCanvas branch compile while calling a method it does not have.
  expect(code).not.toContain('as unknown as CanvasRenderingContext2D');
  expect(code).not.toMatch(/\bas any\b/);
});
