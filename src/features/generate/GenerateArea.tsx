import { Segmented } from '@/components/ui';
import { GeneratePanel } from '@/features/generate/GeneratePanel';
import { MODES, type Mode } from '@/features/generate/mode';
import { RefinePanel } from '@/features/refine/RefinePanel';

/**
 * The generation FORM: the Create | Refine switch and the active panel, and
 * nothing else.
 *
 * The gallery used to be the hero surface BESIDE this panel (a side-by-side
 * split, or a slide-in sheet over the artwork on a narrow viewport). It is now
 * its own top-level tab (docs/17 row 30), so there is no artwork to lay out
 * beside and nothing for a "Controls" sheet to reveal: the form is the whole
 * tab, bounded locally (`max-w-xl`) and centred rather than stretched across a
 * wide window.
 *
 * `mode` and `sourceId` are CONTROLLED from `App`, because the Gallery tab's
 * "Refine this" has to set both and then select this tab (docs/17 row 30). The
 * Create | Refine switch is the form's first control; `App` owns the value.
 */
export function GenerateArea({
  mode,
  onModeChange,
  sourceId,
  onSourceChange,
}: Readonly<{
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /** The refinement source image id, or null for none. */
  sourceId: string | null;
  onSourceChange: (id: string | null) => void;
}>): React.JSX.Element {
  return (
    <section
      aria-label="Controls"
      className="card mx-auto flex w-full max-w-xl flex-col gap-2 p-3"
    >
      <Segmented
        label="Generation mode"
        options={MODES}
        value={mode}
        onChange={onModeChange}
      />
      {mode === 'Create' ? (
        <GeneratePanel />
      ) : (
        <RefinePanel sourceId={sourceId} onSourceChange={onSourceChange} />
      )}
    </section>
  );
}
