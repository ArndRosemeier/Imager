/**
 * The shared UI blocks: the segmented switch and the empty-state surface. Their
 * styling comes from `styles.ts` and the theme seam's stylesheet; nothing here
 * invents a colour or a font size of its own.
 */

import { focusRing } from '@/components/styles';

/** A quiet, honest presentation for a genuinely empty surface (rule 1). */
export function EmptyState({
  title,
  hint,
}: Readonly<{ title: string; hint?: string }>): React.JSX.Element {
  return (
    <div className="card flex flex-col items-center gap-1 px-6 py-10 text-center">
      <p className="text-heading text-ink">{title}</p>
      {hint !== undefined && <p className="max-w-md text-body text-muted">{hint}</p>}
    </div>
  );
}

/** A labelled switch between a small set of exclusive choices. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: Readonly<{
  label: string;
  options: readonly T[];
  value: T;
  onChange: (option: T) => void;
}>): React.JSX.Element {
  return (
    <div role="tablist" aria-label={label} className="seg-group">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={value === option}
          className={`seg-item ${focusRing} ${
            value === option ? 'seg-item-active' : 'hover:seg-item-hover'
          }`}
          onClick={() => {
            onChange(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
