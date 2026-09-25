import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { DEFAULT_THEME } from '@/lib/theme';

afterEach(() => {
  cleanup();
});

// Every test starts from the state a fresh browser load has: no stored theme,
// so the documented default (dark) is what is on <html>. jsdom does not run
// index.html's pre-paint script, so this mirrors it — the script's own
// agreement with the seam is pinned in tests/architecture/theme-startup.test.ts.
beforeEach(() => {
  try {
    localStorage.removeItem('imager.theme');
  } catch {
    // No localStorage in this environment; nothing to reset.
  }
  document.documentElement.classList.toggle('dark', DEFAULT_THEME === 'dark');
  document.documentElement.style.colorScheme = DEFAULT_THEME;
});
