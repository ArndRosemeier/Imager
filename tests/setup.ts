import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach } from 'vitest';

import { DEFAULT_THEME } from '@/lib/theme';

afterEach(() => {
  cleanup();
  // `toastError` uses `duration: Infinity` (a real error must not vanish on its
  // own), so a toast outlives its test unless it is dismissed. Two tests in one
  // file that both fail a run would otherwise leave the second one asserting
  // against the first one's toast too.
  toast.dismiss();
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
