import { useEffect, useState } from 'react';

import { buttonClass, focusRing } from '@/components/styles';
import { EmptyState } from '@/components/ui';
import { listImages } from '@/db/imageRepo';
import type { StoredImage } from '@/domain/image';
import { filterImages, tagCounts, type TagMatchMode } from '@/domain/tags';
import { TagBar } from '@/features/gallery/TagBar';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { nextSelection } from '@/features/store/selection';
import { uploadStoredImages, type UploadProgress } from '@/features/store/storeTransfer';
import { errorMessage, toError } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  DEFAULT_STORE_QUALITY,
  storeEncodingDescription,
  type StoreQuality,
} from '@/server/store-encode';
import type { StoreConnection } from '@/server/store-session';

/**
 * THE LIBRARY PUSH (docs/17 row 45): the second, primary upload entry point —
 * "these are the images I already made in Imager; put them in the store".
 *
 * WHY IT EXISTS: the store's original upload control takes files from the
 * DEVICE, so an image generated in Imager could only reach the store by being
 * downloaded and re-uploaded. The owner reported exactly that gap. This control
 * closes it without a second write path: it reads the LOCAL gallery rows
 * (`listImages`) and hands them to the SAME `uploadStoredImages` →
 * `uploadSources` → encoder → `uploadImage` chain the device picker uses.
 *
 * WHAT IS REUSED, DELIBERATELY (rule 4):
 *  * the rows — `listImages()` from the image repo, so the picker shows the
 *    gallery's own order (favourites first, newest-first) and its own fields;
 *  * the tag filter — the gallery's `TagBar` over `tagCounts`/`filterImages`
 *    from `src/domain/tags.ts`, the ONE tag seam (the store pane uses it too);
 *  * the multiselect gesture — `nextSelection` in `selection.ts`, the same
 *    click / ctrl-cmd / shift-range the store pane uses;
 *  * the thumbnails — `useImageUrl`, the LOCAL gallery's own object-URL hook.
 *    `useStoreThumbnail` is the wrong tool here: it is addressed by a STORE
 *    object name plus the listing's `sha256` and its whole job is fetching and
 *    deriving a reduced copy. A local row already holds its bytes in Dexie, so
 *    there is nothing to fetch and nothing to derive.
 *
 * The trigger lives in BOTH the connected folder dialog and the store tab's
 * degraded surfaces, so an owner with no key still sees the capability and the
 * reason it cannot run (the existing degraded-mode rule).
 */
export function LibraryPushControl({
  connection,
  destination,
  blockedReason = null,
  quality = DEFAULT_STORE_QUALITY,
  onPushed,
}: Readonly<{
  /** The connected store, or `null` when pushing is impossible right now. */
  connection: StoreConnection | null;
  /** The folder a push targets, or `null` when there is none to target. */
  destination: string | null;
  /** Why a push cannot happen, stated on screen; `null` when it can. */
  blockedReason?: string | null | undefined;
  /** The dialog's chosen quality, so both upload actions share ONE setting. */
  quality?: StoreQuality;
  /** Called after a batch so the store view re-reads its listing. */
  onPushed: () => void;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const reason =
    blockedReason ??
    (connection === null
      ? 'Pushing needs a ServerStore key. Connect one on this tab first — your library works without it.'
      : destination === null
        ? 'There is no store folder to push into yet. Create one in the folder pane first.'
        : null);
  return (
    <>
      <button
        type="button"
        className={buttonClass('primary')}
        onClick={() => {
          setOpen(true);
        }}
      >
        Add from gallery…
      </button>
      {open && (
        <LibraryPicker
          connection={connection}
          destination={destination}
          reason={reason}
          quality={quality}
          onClose={() => {
            setOpen(false);
          }}
          onPushed={onPushed}
        />
      )}
    </>
  );
}

/**
 * The picker itself: the local library, filtered by the SAME tag bar the
 * gallery and the store pane use, with multiselect and a per-image result list.
 */
function LibraryPicker({
  connection,
  destination,
  reason,
  quality,
  onClose,
  onPushed,
}: Readonly<{
  connection: StoreConnection | null;
  destination: string | null;
  reason: string | null;
  quality: StoreQuality;
  onClose: () => void;
  onPushed: () => void;
}>): React.JSX.Element {
  const [images, setImages] = useState<StoredImage[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<TagMatchMode>('AND');
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [busy, setBusy] = useState(false);

  // The library is read ONCE, when the picker opens. This is the gallery's own
  // read (`listImages`), so the picker cannot invent a second ordering, and the
  // read failure is visible in the dialog rather than a silently empty list.
  useEffect(() => {
    let cancelled = false;
    listImages().then(
      (rows) => {
        if (!cancelled) setImages(rows);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(toError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = images ?? [];
  const derivedTags = tagCounts(rows);
  const visible = filterImages(rows, selectedTags, matchMode);
  const selectedRows = rows.filter((image) => selected.includes(image.id));
  const canPush = connection !== null && destination !== null && reason === null;

  const toggleSelect = (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ): void => {
    const next = nextSelection(
      selected,
      anchor,
      visible.map((image) => image.id),
      id,
      event,
    );
    setSelected(next.selected);
    setAnchor(next.anchor);
  };

  const push = (): void => {
    if (connection === null || destination === null || selectedRows.length === 0) return;
    const target = destination;
    setBusy(true);
    setProgress([]);
    uploadStoredImages(
      connection,
      target,
      selectedRows,
      (entry) => {
        setProgress((current) => [...current.filter((row) => row.key !== entry.key), entry]);
      },
      quality,
    )
      .then(
        (results) => {
          const failed = results.filter((row) => row.phase === 'failed');
          if (failed.length === 0) {
            toastSuccess(
              `Added ${String(results.length)} image${results.length === 1 ? '' : 's'} to ${target}`,
              storeEncodingDescription(quality),
            );
          } else {
            toastError(
              `${String(failed.length)} of ${String(results.length)} images did not reach the store`,
              new Error(failed[0]?.error ?? ''),
            );
          }
          onPushed();
        },
        (error: unknown) => {
          toastError('Could not push your images into the store', error);
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div
      role="dialog"
      aria-label="Add images from your library"
      className="fixed inset-0 z-20 flex flex-col bg-overlay p-3 sm:p-6"
    >
      <div className="card mx-auto flex max-h-full w-full max-w-5xl flex-col gap-2 overflow-y-auto p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-heading text-ink">Add images from your library</h2>
          <button type="button" className={buttonClass('secondary')} onClick={onClose}>
            Close
          </button>
        </div>
        <p className="text-caption text-muted">
          Destination:{' '}
          <span className="font-mono">{destination ?? '—'}</span>
          {destination === null ? '' : ' (the folder open in the folder pane)'} ·{' '}
          {storeEncodingDescription(quality)}
        </p>
        {/*
          The reason a push cannot run, in the place the owner would otherwise
          look for a dead button. The library below still lists his images, which
          is the point of the no-key rule: the store is what is missing, not the
          library.
        */}
        {reason !== null && (
          <p role="status" className="card border-warn bg-warn-surface p-3 text-body text-on-warn-surface">
            {reason}
          </p>
        )}
        {loadError !== null ? (
          <p role="alert" className="card border-danger bg-danger-surface p-3 text-body text-on-danger-surface">
            Could not read your library: {errorMessage(loadError)}
          </p>
        ) : images === null ? (
          <p className="text-body text-muted">Reading your library…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No images in your library yet."
            hint="Generate one on the Generate tab — or refine an image you already have — and it will be here to push."
          />
        ) : (
          <>
            <TagBar
              tags={derivedTags}
              selected={selectedTags}
              mode={matchMode}
              onToggle={(tag) => {
                setSelectedTags((current) =>
                  current.includes(tag)
                    ? current.filter((entry) => entry !== tag)
                    : [...current, tag],
                );
              }}
              onModeChange={setMatchMode}
              onClear={() => {
                setSelectedTags([]);
              }}
            />
            <p className="text-caption text-muted">
              Showing {visible.length} of {rows.length} images
            </p>
            <p className="text-caption text-muted" aria-live="polite">
              {selected.length === 0 ? 'no images selected' : `${String(selected.length)} selected`}
            </p>
            {visible.length === 0 ? (
              <p className="card p-3 text-body text-muted">No library image carries these tags.</p>
            ) : (
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5">
                {visible.map((image) => (
                  <LibraryTile
                    key={image.id}
                    image={image}
                    selected={selected.includes(image.id)}
                    onSelect={(event) => {
                      toggleSelect(image.id, event);
                    }}
                  />
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-strong pt-2">
              <button
                type="button"
                className={buttonClass('primary')}
                disabled={!canPush || busy || selectedRows.length === 0}
                onClick={push}
              >
                {busy
                  ? 'Pushing…'
                  : selectedRows.length > 1
                    ? `Add ${String(selectedRows.length)} to the store`
                    : 'Add to the store'}
              </button>
              <button
                type="button"
                className={buttonClass('secondary')}
                disabled={visible.length === 0}
                onClick={() => {
                  setSelected(visible.map((image) => image.id));
                }}
              >
                Select all
              </button>
              <button
                type="button"
                className={buttonClass('ghost')}
                disabled={selected.length === 0}
                onClick={() => {
                  setSelected([]);
                }}
              >
                Clear selection
              </button>
            </div>
          </>
        )}

        {progress.length > 0 && (
          <ul aria-label="Push progress" className="card flex flex-col gap-1 p-2">
            {progress.map((row) => (
              <li key={row.key} className="flex flex-wrap items-baseline gap-2 text-caption">
                <span className="min-w-0 flex-1 truncate text-ink">{row.label}</span>
                {row.phase === 'failed' ? (
                  <span className="text-danger">{row.error ?? 'failed'}</span>
                ) : (
                  <span className="text-muted">
                    {row.phase === 'done' ? `stored as ${row.name ?? ''}` : row.phase}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One local library image. The thumbnail is the LOCAL gallery's own object URL
 * (`useImageUrl`): the bytes are already in Dexie, so there is nothing for the
 * store's fetch-and-derive thumbnail hook to do.
 */
function LibraryTile({
  image,
  selected,
  onSelect,
}: Readonly<{
  image: StoredImage;
  selected: boolean;
  onSelect: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
}>): React.JSX.Element {
  const url = useImageUrl(image);
  return (
    <div
      className={`relative aspect-square w-full overflow-hidden rounded-lg ${
        selected ? 'ring-2 ring-accent' : ''
      }`}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? 'Selected' : 'Select'} library image: ${image.prompt}`}
        className={`group relative block h-full w-full bg-subtle ${focusRing}`}
        onClick={(event) => {
          onSelect({ ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey });
        }}
      >
        {url !== null ? (
          <img
            src={url}
            alt={image.prompt}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-caption text-muted">
            loading…
          </span>
        )}
        <span className="tile-caption group-hover:opacity-100 group-focus-within:opacity-100">
          <span className="line-clamp-2 min-w-0 text-left">{image.prompt}</span>
        </span>
        {selected && (
          <span className="absolute top-1 left-1 rounded-full bg-accent px-1 text-caption text-on-accent">
            ✓
          </span>
        )}
      </button>
    </div>
  );
}
