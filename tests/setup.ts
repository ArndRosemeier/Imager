import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { webcrypto } from 'node:crypto';

import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach } from 'vitest';

import { DEFAULT_THEME } from '@/lib/theme';

/*
 * jsdom implements no `SubtleCrypto` (MEASURED: jsdom 30's `Crypto` carries
 * `getRandomValues`/`randomUUID` only), so the export seam's per-image SHA-256
 * would throw in every test. Node's WebCrypto is installed under the SAME name
 * with the SAME method signature and the SAME async-ness — an honest stand-in
 * for the algorithm, not a fake digest (ledger rows 14/15: a double that
 * invents a different shape certifies code the real object refuses). The real
 * browser computes the real hash, and the ledger row pins the archive's
 * sha256 against Node's independent digest.
 */
Object.defineProperty(globalThis.crypto, 'subtle', {
  configurable: true,
  value: webcrypto.subtle,
});

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
