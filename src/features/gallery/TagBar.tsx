/**
 * The TAG BAR (docs/17 row 34): every tag in use as a selectable chip with the
 * number of images carrying it, the AND/OR match switch, and a clear-all.
 *
 * The list it renders is DERIVED, not stored — the caller computes it from the
 * images it already read (`tagCounts` in `src/domain/tags.ts`), so a tag no
 * image carries is simply not in the list and there is no second source of
 * truth to keep in sync. This component owns no state: the selection and the
 * match mode live in the gallery, which is the one place that filters.
 */
import { Segmented } from '@/components/ui';
import { buttonClass, focusRing } from '@/components/styles';
import { TAG_MATCH_MODES, type TagCount, type TagMatchMode } from '@/domain/tags';

export function TagBar({
  tags,
  selected,
  mode,
  onToggle,
  onModeChange,
  onClear,
}: Readonly<{
  /** The derived tag list, alphabetical, with per-tag image counts. */
  tags: readonly TagCount[];
  /** The tags currently filtering the grid. */
  selected: readonly string[];
  /** AND narrows (every selected tag), OR widens (any selected tag). */
  mode: TagMatchMode;
  onToggle: (tag: string) => void;
  onModeChange: (mode: TagMatchMode) => void;
  onClear: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label text-muted">Tags</span>
        {tags.map(({ tag, count }) => {
          const active = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              /*
               * `aria-pressed` carries the selection to AT, and the count is in
               * the accessible NAME so the number is never a colour-only cue.
               * The visible state is `.tag-chip-on` (plain CSS, so it cannot
               * lose the cascade to the `chip` utility).
               */
              aria-pressed={active}
              aria-label={`${tag} (${count} ${count === 1 ? 'image' : 'images'})`}
              className={`chip ${focusRing} ${active ? 'tag-chip-on' : 'hover:seg-item-hover'}`}
              onClick={() => {
                onToggle(tag);
              }}
            >
              <span>{tag}</span>
              <span className="text-caption">{count}</span>
            </button>
          );
        })}
        {/*
          The AND/OR switch is the app's ONE segmented control, so it inherits
          the shared recipe instead of growing a second switch shape. Its labels
          ARE the owner's words.
        */}
        <Segmented
          label="Tag match"
          options={TAG_MATCH_MODES}
          value={mode}
          onChange={onModeChange}
        />
        <button
          type="button"
          disabled={selected.length === 0}
          className={buttonClass('secondary')}
          onClick={onClear}
        >
          Clear tags
        </button>
      </div>
      <p className="text-caption text-muted">
        AND matches every selected tag (narrower); OR matches any one of them (wider).
      </p>
    </div>
  );
}
