import { useEffect, useState } from 'react';

import { Segmented } from '@/components/ui';
import { buttonClass, focusRing } from '@/components/styles';
import { GeneratePanel } from '@/features/generate/GeneratePanel';
import { RefinePanel } from '@/features/refine/RefinePanel';
import { Gallery } from '@/features/gallery/Gallery';
import { useMinWidth, WIDE_QUERY } from '@/lib/media';

const MODES = ['Create', 'Refine'] as const;
type Mode = (typeof MODES)[number];

/**
 * The generation AREA: the images as the hero surface, the form in a CONTROLS
 * panel beside (wide screens) or over (narrow screens) them.
 *
 * The mode and the refinement source live here because the gallery's lightbox
 * ("Refine this") and the refine form must agree on them — a panel-local copy
 * could drift. The Create | Refine switch is the first control in the panel, so
 * it disappears with the panel instead of occupying a row of its own.
 *
 * It is a tablist, not a router: the static host has no history fallback.
 *
 * The lightbox's "Chat with this image" does NOT live here: it crosses into the
 * Chat tab, so the request is owned by `App`, which owns the tab (row 17). This
 * component only forwards the callback.
 */
export function GenerateArea({
  open,
  onClose,
  onChat,
}: Readonly<{
  /** The controls panel is open (narrow viewport); ignored from `lg` up. */
  open: boolean;
  onClose: () => void;
  /** Present → the gallery lightbox offers "Chat with this image" (row 17). */
  onChat?: ((imageId: string) => void) | undefined;
}>): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('Create');
  const [refineSourceId, setRefineSourceId] = useState<string | null>(null);
  const [galleryVersion, setGalleryVersion] = useState(0);
  const wide = useMinWidth(WIDE_QUERY);

  // Escape closes the panel — but only where it is dismissible. From `lg` up it
  // is the persistent rail, and Escape must not empty the screen.
  useEffect(() => {
    if (!open || wide) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, wide, onClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse gap-3 lg:flex-row lg:items-start">
      {/*
        The controls panel. Wide screens: a persistent side rail (never over the
        artwork). Narrow screens: a slide-in sheet over the artwork, opened by
        the header's "Controls" button and closed by "✕", Escape, or the
        backdrop — so the artwork can never be permanently covered.
      */}
      <aside
        aria-label="Controls"
        data-panel={open ? 'open' : 'closed'}
        className="card panel-sheet w-full gap-2 lg:w-[22rem]"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-heading text-ink">Controls</h2>
          <button
            type="button"
            className={`${buttonClass('ghost', focusRing)} lg:hidden`}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <Segmented
          label="Generation mode"
          options={MODES}
          value={mode}
          onChange={(next) => {
            setMode(next);
          }}
        />
        {mode === 'Create' ? (
          <GeneratePanel
            onFinished={() => {
              setGalleryVersion((v) => v + 1);
            }}
          />
        ) : (
          <RefinePanel
            sourceId={refineSourceId}
            onSourceChange={setRefineSourceId}
            onFinished={() => {
              setGalleryVersion((v) => v + 1);
            }}
          />
        )}
      </aside>
      <Gallery
        version={galleryVersion}
        onRefine={(imageId) => {
          setRefineSourceId(imageId);
          setMode('Refine');
        }}
        onChat={onChat}
      />
    </div>
  );
}
