import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { App } from '@/App';
import { DEFAULT_THEME, THEME_STORAGE_KEY, getTheme } from '@/lib/theme';
import { jsonResponse } from '../helpers';

const html = readFileSync('index.html', 'utf8');

/**
 * The anti-flash bootstrap is an inline script in index.html, so it cannot
 * import the theme seam. These pins are what keeps the two from drifting:
 * same storage key, same single comparison, same dark default.
 */
it('index.html applies the persisted theme before the app bundle loads', () => {
  const scriptStart = html.indexOf('<script>');
  const bundle = html.indexOf('src="/src/main.tsx"');
  expect(scriptStart).toBeGreaterThan(-1);
  expect(bundle).toBeGreaterThan(-1);
  // Before the module script: a later script would paint the wrong theme first.
  expect(scriptStart).toBeLessThan(bundle);

  const inline = html.slice(scriptStart, html.indexOf('</script>', scriptStart));
  // The SAME key the seam persists under, read synchronously.
  expect(inline).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  // The SAME default: only the exact string 'light' leaves dark.
  expect(inline).toMatch(/stored === 'light' \? 'light' : 'dark'/);
  expect(inline).toContain("classList.toggle('dark'");
});

it('the seam and the bootstrap agree on the default', () => {
  expect(DEFAULT_THEME).toBe('dark');
  localStorage.removeItem(THEME_STORAGE_KEY);
  expect(getTheme()).toBe('dark');
  localStorage.setItem(THEME_STORAGE_KEY, 'light');
  expect(getTheme()).toBe('light');
  localStorage.setItem(THEME_STORAGE_KEY, 'nonsense');
  expect(getTheme()).toBe('dark');
});

/**
 * Whole width (slice 3): the page wrapper must not cap itself, or every
 * screen collapses back into the old 768px column. A LOCAL cap on a prose
 * block is allowed and expected — the pin is that the app's own page `main`
 * element carries the page fill and no max width.
 */
it('the app has no page-level width cap', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({})));
  try {
    render(<App />);
    await screen.findByText(/Enter an OpenRouter API key in Settings/);
    const main = screen.getByRole('main');
    const classes = main.className.split(/\s+/);
    expect(classes).toContain('w-full');
    expect(classes.filter((c) => c.startsWith('max-w-'))).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
