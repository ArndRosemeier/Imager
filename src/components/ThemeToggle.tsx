import { focusRing } from '@/components/styles';
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
    <div role="group" aria-label="Theme" className="seg-group">
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          className={`seg-item ${focusRing} ${
            theme === option ? 'seg-item-active' : 'hover:seg-item-hover'
          }`}
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
