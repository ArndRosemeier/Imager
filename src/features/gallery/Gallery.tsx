import { useEffect, useState } from 'react';

import { EmptyState, CopyButton, FavoriteButton, SaveButton, Segmented } from '@/components/ui';
import { buttonClass } from '@/components/styles';
import { deleteImage, getRun, listImages, setImageFavorite, setImageTags } from '@/db/imageRepo';
import { type Run, type StoredImage } from '@/domain/image';
import { filterImages, tagCounts, type TagMatchMode } from '@/domain/tags';
import { imageFileName } from '@/features/export/exportLibrary';
import { GALLERY_GRID_CLASS, GALLERY_SIZES, useGallerySize } from '@/features/gallery/gallerySize';
import { TagBar } from '@/features/gallery/TagBar';
import { TagEditor } from '@/features/gallery/TagEditor';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/**
 * One tile of the hero grid: the artwork fills the tile and the prompt reads
 * over it, at a glance. The MODEL id is deliberately NOT here — every tile
 * repeating it was noise; it lives in the full view, where it is read once and
 * on purpose.
 *
 * The tile is a NON-interactive wrapper because it holds THREE controls: the
 * open action, the favourite star and the prompt-copy control. A control nested
 * inside the open `<button>` would be interactive content inside interactive
 * content — invalid HTML, and it breaks keyboard and AT behaviour for both. The
 * caption stays a pointer-transparent overlay (so the artwork is still the click
 * target) and each control re-enables pointer events for itself.
 */
function Thumb({
  image,
  onOpen,
  onToggleFavorite,
}: {
  image: StoredImage;
  onOpen: () => void;
  onToggleFavorite: () => Promise<void>;
}): React.JSX.Element {
  const url = useImageUrl(image);
  return (
    <div className="group relative aspect-square w-full overflow-hidden rounded-lg bg-subtle">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open image: ${image.prompt}`}
        className={`focus-ring focus-visible:focus-ring-on block h-full w-full`}
      >
        {url !== null && (
          <img
            src={url}
            alt={image.prompt}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        )}
      </button>
      <span className="tile-caption group-hover:opacity-100 group-focus-within:opacity-100">
        <span className="flex w-full min-w-0 items-end justify-between gap-2">
          <span className="line-clamp-2 min-w-0 text-left">{image.prompt}</span>
          {/*
            The tile's TWO sibling controls: the favourite star and the prompt
            copy. Both appear on hover (pointer) and on focus (keyboard, via
            `group-focus-within`), and `.tile-control` keeps them ALWAYS visible
            where no hover exists (touch) — a control nobody can reveal is not a
            control. A FAVOURITE's star stays visible even un-hovered, because it
            is a status as much as an action (`.tile-favorite-on`).
          */}
          <span className="flex shrink-0 items-center gap-1">
            <span
              className={`tile-control pointer-events-auto group-hover:opacity-100 group-focus-within:opacity-100 ${
                image.favorite ? 'tile-favorite-on' : ''
              }`}
            >
              <FavoriteButton
                favorite={image.favorite}
                onToggle={onToggleFavorite}
                variant="invert"
              />
            </span>
            <span className="tile-control pointer-events-auto group-hover:opacity-100 group-focus-within:opacity-100">
              <CopyButton
                text={image.prompt}
                label={`Copy prompt: ${image.prompt}`}
                variant="invert"
              />
            </span>
          </span>
        </span>
      </span>
    </div>
  );
}

function Lightbox(props: {
  image: StoredImage;
  /** Every tag in use in the library, for the editor's suggestions. */
  allTags: readonly string[];
  onClose: () => void;
  onDeleted: () => void;
  onToggleFavorite: () => Promise<void>;
  onSetTags: (next: string[]) => Promise<void>;
  onRefine?: (() => void) | undefined;
  onChat?: (() => void) | undefined;
}): React.JSX.Element {
  const { image } = props;
  const url = useImageUrl(image);
  const [run, setRun] = useState<Run | undefined>(undefined);
  useEffect(() => {
    getRun(image.runId).then(setRun, (error: unknown) => {
      // An uploaded image has no run (runId ''), so there is nothing to load
      // and nothing to report.
      if (image.runId !== '') toastError('Could not load the run for this image', error);
    });
  }, [image.runId]);
  const onDelete = (): void => {
    deleteImage(image.id).then(props.onDeleted, (error: unknown) => {
      toastError('Could not delete the image', error);
    });
  };
  return (
    <div
      role="dialog"
      aria-label="Image details"
      className="fixed inset-0 z-10 flex flex-col bg-black/85 p-4 text-white sm:p-6"
    >
      {/*
        The image takes every pixel the dialog has left: the dialog is the full
        viewport as a flex column, the image area is the only part that grows
        (`min-h-0` lets it shrink below the image's intrinsic size), and the
        image itself is bounded by that area in BOTH directions. The metadata
        and buttons are a compact strip below it, which scrolls when the
        viewport is short so the buttons stay reachable.
      */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {url !== null && (
          <img src={url} alt={image.prompt} className="max-h-full max-w-full object-contain" />
        )}
      </div>
      <div className="mt-3 max-h-[45vh] shrink-0 overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {/*
              The prompt and its copy control on ONE row: the primary case for
              copying is "I am looking at the full prompt", so the control sits
              where the prompt is, not in the button strip below. `variant`
              `invert` is the on-photo role, because the lightbox is a dark
              photo surface in BOTH themes.
            */}
            <div className="flex items-start gap-3">
              <p className="min-w-0 flex-1 text-body">{image.prompt}</p>
              <CopyButton text={image.prompt} label="Copy prompt" variant="invert" />
            </div>
            <p className="font-mono text-caption opacity-80">{image.model}</p>
            <p className="text-caption opacity-80">
              {new Date(image.createdAt).toLocaleString()} · {image.width}×{image.height}
            </p>
            <p className="text-caption opacity-80">
              {`Run cost ${run?.costUsd == null ? 'not reported' : `$${run.costUsd.toFixed(4)}`}`}
            </p>
          </div>
        </div>
        {/*
          The tag editor sits with the metadata it belongs to, on the lightbox's
          dark surface (docs/17 row 34). Its tags come from THIS freshly read
          row, so the chips are always what is stored.
        */}
        <div className="mt-3">
          <TagEditor tags={image.tags} suggestions={props.allTags} onChange={props.onSetTags} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {/*
            The SAME favourite control as the tile (rule 4), on the lightbox's
            dark surface in both themes — so the two surfaces cannot disagree
            about whether this image is a favourite.
          */}
          <FavoriteButton
            favorite={image.favorite}
            onToggle={props.onToggleFavorite}
            variant="invert"
          />
          {url !== null && (
            /*
              One save control, through the ONE save seam (docs/17 row 25): a
              real "Save as…" with a suggested name derived from the prompt
              where the browser has `showSaveFilePicker`, the anchor download
              otherwise. The suggested name is sanitized in the export seam —
              a prompt can contain slashes, newlines, emoji or 200 characters,
              and none of that may reach a file name.
            */
            <SaveButton
              label="Save as…"
              variant="invert"
              buildRequest={() => ({
                fileName: imageFileName(image),
                mimeType: image.mimeType,
                buildBytes: () => image.bytes,
              })}
            />
          )}
          {props.onRefine !== undefined && (
            <button type="button" className={buttonClass('invert')} onClick={props.onRefine}>
              Refine this
            </button>
          )}
          {props.onChat !== undefined && (
            <button type="button" className={buttonClass('invert')} onClick={props.onChat}>
              Chat with this image
            </button>
          )}
          <button type="button" className={buttonClass('dangerInvert')} onClick={onDelete}>
            Delete
          </button>
          <button
            type="button"
            className={`btn-invert hover:btn-invert-hover focus-ring-photo focus-visible:focus-ring-photo-on`}
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The gallery: its own top-level tab, and the app's primary surface.
 * Edge-to-edge tiles on a tight gutter, more columns as the window grows, the
 * artwork filling each tile.
 *
 * There is NO refresh-counter prop: the Gallery is mounted only while its tab
 * is active (docs/17 row 30), so entering the tab re-runs the list read and a
 * freshly generated image is there. `localVersion` still exists for the one
 * change that happens WHILE this component is mounted — a deletion in the
 * lightbox.
 */
export function Gallery({
  onRefine,
  onChat,
}: Readonly<{
  /** Present → the lightbox offers "Refine this" for the open image. */
  onRefine?: ((imageId: string) => void) | undefined;
  /** Present → the lightbox offers "Chat with this image" for the open image. */
  onChat?: ((imageId: string) => void) | undefined;
}>): React.JSX.Element {
  const [images, setImages] = useState<StoredImage[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [localVersion, setLocalVersion] = useState(0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  /**
   * The tag FILTER state (docs/17 row 34): which tags are selected and whether
   * they match all (AND) or any (OR). It lives HERE, beside the rows it filters
   * — the bar is a pure view of it — and it is deliberately NOT persisted: a
   * stale filter that hides the library on the next visit is a trap, while the
   * size preference (which hides nothing) is persisted through its own seam.
   */
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<TagMatchMode>('AND');
  const [size, setSize] = useGallerySize();
  useEffect(() => {
    listImages().then(setImages, (error: unknown) => {
      setLoadError(toError(error));
    });
  }, [localVersion]);
  /**
   * ONE favourite write for BOTH surfaces (rule 4). The repo updates the single
   * field without touching the row's bytes, and then the list is re-read — which
   * is also what re-applies the favourite-first order. The lightbox and the tile
   * cannot disagree afterwards, because both render the same freshly read row.
   */
  const toggleFavorite = (image: StoredImage): Promise<void> =>
    setImageFavorite(image.id, !image.favorite).then(() => {
      setLocalVersion((v) => v + 1);
    });
  /**
   * ONE tag write, for the lightbox's editor: the repo swaps only the tags field
   * (bytes untouched — the row-32 trap) and the re-read is what updates the
   * lightbox chips AND the derived tag bar together, so the two can never
   * disagree.
   */
  const setTags = (image: StoredImage, next: string[]): Promise<void> =>
    setImageTags(image.id, next).then(() => {
      setLocalVersion((v) => v + 1);
    });
  if (loadError !== null) throw loadError;
  if (images === null) return <p className="text-body text-muted">Loading gallery…</p>;
  const open = images.find((i) => i.id === openId);
  // The bar's list is DERIVED from the rows above — never stored, never a
  // second source of truth (docs/17 row 34).
  const tagList = tagCounts(images);
  const allTags = tagList.map((entry) => entry.tag);
  // The ONE ordering seam's order, filtered — `filterImages` preserves the input
  // order, so favourites still lead and newest-first still holds inside a group.
  const visible = filterImages(images, selectedTags, matchMode);
  return (
    <section aria-label="Gallery" className="min-w-0 flex-1">
      {images.length === 0 ? (
        <EmptyState
          title="No images yet."
          hint="Generate one, or refine an image you already have — every result lands here."
        />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <TagBar
              tags={tagList}
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
            {/*
              The image size control (docs/17 row 34). `Segmented` is the app's
              ONE switch; the options are the three `GALLERY_GRID_CLASS` steps and
              Medium is the grid the gallery already had.
            */}
            <Segmented
              label="Image size"
              options={GALLERY_SIZES}
              value={size}
              onChange={setSize}
            />
          </div>
          {/*
            "6 of 20", always: a filter that is hiding images must never be
            silent about it, and an unfiltered grid reads honestly as "20 of 20".
          */}
          <p className="mb-2 text-caption text-muted">
            Showing {visible.length} of {images.length} images
          </p>
          {visible.length === 0 ? (
            <EmptyState
              title="No images match these tags."
              hint="Clear a tag, or switch AND to OR, to widen the selection."
            />
          ) : (
            <div className={`grid gap-0.5 ${GALLERY_GRID_CLASS[size]}`}>
              {visible.map((image) => (
                <Thumb
                  key={image.id}
                  image={image}
                  onOpen={() => {
                    setOpenId(image.id);
                  }}
                  onToggleFavorite={() => toggleFavorite(image)}
                />
              ))}
            </div>
          )}
        </>
      )}
      {open !== undefined && (
        <Lightbox
          image={open}
          allTags={allTags}
          onClose={() => {
            setOpenId(null);
          }}
          onDeleted={() => {
            setOpenId(null);
            setLocalVersion((v) => v + 1);
          }}
          onToggleFavorite={() => toggleFavorite(open)}
          onSetTags={(next) => setTags(open, next)}
          onRefine={
            onRefine === undefined
              ? undefined
              : () => {
                  setOpenId(null);
                  onRefine(open.id);
                }
          }
          onChat={
            onChat === undefined
              ? undefined
              : () => {
                  setOpenId(null);
                  onChat(open.id);
                }
          }
        />
      )}
    </section>
  );
}
