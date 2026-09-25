/**
 * THE theme seam (slice 3): the ONE place the theme is read, applied,
 * persisted and watched. Nothing else touches the document root class list or
 * the theme key.
 *
 * SOURCE OF TRUTH: `localStorage` — chosen deliberately. `index.html` needs
 * the choice BEFORE first paint (a Dexie read is async, so a Dexie-first
 * theme would flash the wrong background on every load), and localStorage is
 * the only store readable synchronously there. One store, one direction, no
 * mirroring: a Dexie copy could only drift from the value the pre-paint
 * script already applied. Absent = nothing stored = DARK (the owner's ask).
 *
 * The pre-paint script in `index.html` duplicates the key and the dark
 * default; `tests/architecture/theme-startup.test.ts` pins that they agree.
 */
import { useSyncExternalStore } from 'react';

export const THEME_STORAGE_KEY = 'imager.theme';

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

/** Default when nothing is stored — the owner asked for dark. */
export const DEFAULT_THEME: Theme = 'dark';

const listeners = new Set<() => void>();

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** The persisted choice, or the documented default when there is none. */
export function getTheme(): Theme {
  let stored: string | null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage unavailable (blocked cookies / private mode): nothing is
    // stored, so the default applies. A genuine first-run state, not a
    // swallowed failure — there is no user data to lose (rule 1).
    stored = null;
  }
  return isTheme(stored) ? stored : DEFAULT_THEME;
}

/** Applies a theme to the document root (the class Tailwind's `dark:`
 * variant keys on) and persists it as the owner's choice. */
export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Applied for this session; only persistence failed. Nothing in the app
    // reads it back, so there is no user-visible consequence to surface.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current theme; a change re-renders every caller. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);
}

export function toggleTheme(): void {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
