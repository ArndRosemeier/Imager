import { useState } from 'react';

import { GeneratePanel } from '@/features/generate/GeneratePanel';
import { RefinePanel } from '@/features/refine/RefinePanel';
import { Gallery } from '@/features/gallery/Gallery';

const MODES = ['Create', 'Refine'] as const;
type Mode = (typeof MODES)[number];

/**
 * The generation AREA: the Create | Refine switch, the active panel, and the
 * ONE gallery both modes land their results in. The mode and the refinement
 * source live here because the gallery's lightbox ("Refine this") and the
 * refine form must agree on them — a panel-local copy could drift.
 *
 * It is a tablist, not a router: the static host has no history fallback.
 */
export function GenerateArea(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('Create');
  const [refineSourceId, setRefineSourceId] = useState<string | null>(null);
  const [galleryVersion, setGalleryVersion] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <nav role="tablist" aria-label="Generation mode" className="flex gap-2">
        {MODES.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={mode === option}
            className="rounded border border-strong px-3 py-1 aria-selected:bg-subtle"
            onClick={() => {
              setMode(option);
            }}
          >
            {option}
          </button>
        ))}
      </nav>
      <div className="grid gap-6 lg:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)]">
        {mode === 'Create' ? (
          <GeneratePanel onFinished={() => { setGalleryVersion((v) => v + 1); }} />
        ) : (
          <RefinePanel
            sourceId={refineSourceId}
            onSourceChange={setRefineSourceId}
            onFinished={() => {
              setGalleryVersion((v) => v + 1);
            }}
          />
        )}
        <Gallery
          version={galleryVersion}
          onRefine={(imageId) => {
            setRefineSourceId(imageId);
            setMode('Refine');
          }}
        />
      </div>
    </div>
  );
}
