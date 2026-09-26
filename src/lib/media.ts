import { useEffect, useState } from 'react';

/**
 * A media query as React state — the ONE place a component asks "is the
 * viewport at least this wide?", so the art-forward layout's responsive
 * decisions (persistent side rail vs. slide-in panel) agree everywhere.
 *
 * `initial` is the answer when there is no `matchMedia` at all (jsdom): a
 * defensive default, not a guess about a real browser.
 */
export function useMinWidth(query: string, initial = false): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? initial
      : window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = (): void => {
      setMatches(list.matches);
    };
    update();
    list.addEventListener('change', update);
    return () => {
      list.removeEventListener('change', update);
    };
  }, [query]);
  return matches;
}

/** Tailwind's `lg` breakpoint: the width at which the side rail becomes persistent. */
export const WIDE_QUERY = '(min-width: 1024px)';
