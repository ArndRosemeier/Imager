import { THEMES, setTheme, useTheme, type Theme } from '@/lib/theme';

const LABELS: Record<Theme, string> = { dark: 'Dark', light: 'Light' };

/**
 * The visible theme control (accessible: a named group of pressed toggle
 * buttons). It writes through the ONE theme seam — no local state, so the
 * header and the Settings copy can never disagree.
 */
export function ThemeToggle(): React.JSX.Element {
  const theme = useTheme();
  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-2">
      <span className="text-sm text-muted">Theme</span>
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          className="rounded border border-strong px-2 py-1 text-sm aria-pressed:bg-accent aria-pressed:text-on-accent"
          onClick={() => {
            setTheme(option);
          }}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
