/**
 * The gallery's IMAGE SIZE preference (docs/17 row 34): how dense the tile grid
 * is. Three steps; `Medium` IS the grid the gallery has always rendered, so the
 * default changes nothing for an owner who never touches the control.
 *
 * WHERE IT IS PERSISTED, AND WHY: `localStorage` under `imager.gallerySize` —
 * the same store the theme seam uses (`src/lib/theme.ts`), because this is the
 * same KIND of value: a per-device VIEW preference, not library data. Two
 * consequences decide it against the Dexie settings row:
 *   1. localStorage is readable SYNCHRONOUSLY, so the first render already has
 *      the owner's density. A Dexie read is async, so the grid would paint at
 *      `Medium` and jump a frame later — the exact flash the theme seam was
 *      built to avoid.
 *   2. it is not the owner's work: it must not ride in a backup, must not be
 *      asked about at import, and must not turn a view choice into library data.
 *
 * The KEYS are separate (`imager.theme`, `imager.gallerySize`) because they are
 * separate preferences with separate lifetimes; the STORE is shared.
 */
import { useCallback, useState } from 'react';

export const GALLERY_SIZE_STORAGE_KEY = 'imager.gallerySize';

/** The three steps, smallest tiles first. */
export const GALLERY_SIZES = ['Small', 'Medium', 'Large'] as const;
export type ImageSize = (typeof GALLERY_SIZES)[number];

/** The current grid is the default, so nothing moves for an untouched install. */
export const DEFAULT_GALLERY_SIZE: ImageSize = 'Medium';

/**
 * THE column tracks for each step. Complete literal strings (never composed at
 * runtime) so Tailwind's scanner sees every class it must emit.
 *
 * `Small` packs more tiles per row (smaller artwork), `Large` fewer (bigger
 * artwork). `Medium` is byte-identical to the grid the gallery shipped with:
 * `grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5`.
 */
export const GALLERY_GRID_CLASS: Record<ImageSize, string> = {
  Small: 'grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10',
  Medium: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
  Large: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4',
};

function isGallerySize(value: string | null): value is ImageSize {
  return value !== null && (GALLERY_SIZES as readonly string[]).includes(value);
}

/** The persisted choice, or the documented default when there is none. */
export function getGallerySize(): ImageSize {
  let stored: string | null;
  try {
    stored = localStorage.getItem(GALLERY_SIZE_STORAGE_KEY);
  } catch {
    // Storage unavailable (blocked cookies / private mode): nothing is stored,
    // so the default applies. A genuine first-run state, not a swallowed
    // failure — there is no user data to lose (rule 1).
    stored = null;
  }
  return isGallerySize(stored) ? stored : DEFAULT_GALLERY_SIZE;
}

/** Persists the choice. The caller re-renders from its own state. */
export function setGallerySize(size: ImageSize): void {
  try {
    localStorage.setItem(GALLERY_SIZE_STORAGE_KEY, size);
  } catch {
    // Applied for this session; only persistence failed. The preference still
    // takes effect on screen, and nothing else reads it back, so there is no
    // user-visible consequence to surface.
  }
}

/**
 * The gallery's density, read once at mount (synchronously, so the FIRST paint
 * is already right) and written through on every change. The gallery is the
 * ONE consumer and it owns the only control, so a shared external store would
 * be machinery serving nothing.
 */
export function useGallerySize(): [ImageSize, (size: ImageSize) => void] {
  const [size, setSize] = useState<ImageSize>(() => getGallerySize());
  const choose = useCallback((next: ImageSize) => {
    setGallerySize(next);
    setSize(next);
  }, []);
  return [size, choose];
}
