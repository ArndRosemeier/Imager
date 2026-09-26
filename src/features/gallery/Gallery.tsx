import { useEffect, useState } from 'react';

import { EmptyState, CopyButton, SaveButton } from '@/components/ui';
import { buttonClass } from '@/components/styles';
import { deleteImage, getRun, listImages } from '@/db/imageRepo';
import { type Run, type StoredImage } from '@/domain/image';
import { imageFileName } from '@/features/export/exportLibrary';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/**
 * One tile of the hero grid: the artwork fills the tile and the prompt reads
 * over it, at a glance. The MODEL id is deliberately NOT here — every tile
 * repeating it was noise; it lives in the full view, where it is read once and
 * on purpose.
 *
 * The tile is a NON-interactive wrapper because it holds TWO controls: the open
 * action and the prompt-copy control. A copy button nested inside the open
 * `<button>` would be interactive content inside interactive content — invalid
 * HTML, and it breaks keyboard and AT behaviour for both. The caption stays a
 * pointer-transparent overlay (so the artwork is still the click target) and the
 * copy control re-enables pointer events for itself.
 */
function Thumb({ image, onOpen }: { image: StoredImage; onOpen: () => void }): React.JSX.Element {
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
            The copy control copies the stored prompt, NOT the two clamped lines
            the caption shows. It appears on hover (pointer) and on focus
            (keyboard, via `group-focus-within`), and `.tile-copy` keeps it
            ALWAYS visible where no hover exists (touch) — a control nobody can
            reveal is not a control.
          */}
          <span className="tile-copy pointer-events-auto shrink-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <CopyButton
              text={image.prompt}
              label={`Copy prompt: ${image.prompt}`}
              variant="invert"
            />
          </span>
        </span>
      </span>
    </div>
  );
}

function Lightbox(props: {
  image: StoredImage;
  onClose: () => void;
  onDeleted: () => void;
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
        <div className="mt-3 flex flex-wrap gap-2">
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
 * The gallery: the app's primary surface. Edge-to-edge tiles on a tight
 * gutter, more columns as the window grows, the artwork filling each tile.
 */
export function Gallery({
  version,
  onRefine,
  onChat,
}: Readonly<{
  version: number;
  /** Present → the lightbox offers "Refine this" for the open image. */
  onRefine?: ((imageId: string) => void) | undefined;
  /** Present → the lightbox offers "Chat with this image" for the open image. */
  onChat?: ((imageId: string) => void) | undefined;
}>): React.JSX.Element {
  const [images, setImages] = useState<StoredImage[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [localVersion, setLocalVersion] = useState(0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  useEffect(() => {
    listImages().then(setImages, (error: unknown) => {
      setLoadError(toError(error));
    });
  }, [version, localVersion]);
  if (loadError !== null) throw loadError;
  if (images === null) return <p className="text-body text-muted">Loading gallery…</p>;
  const open = images.find((i) => i.id === openId);
  return (
    <section aria-label="Gallery" className="min-w-0 flex-1">
      {images.length === 0 ? (
        <EmptyState
          title="No images yet."
          hint="Generate one, or refine an image you already have — every result lands here."
        />
      ) : (
        <div className="grid grid-cols-2 gap-0.5 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {images.map((image) => (
            <Thumb
              key={image.id}
              image={image}
              onOpen={() => {
                setOpenId(image.id);
              }}
            />
          ))}
        </div>
      )}
      {open !== undefined && (
        <Lightbox
          image={open}
          onClose={() => {
            setOpenId(null);
          }}
          onDeleted={() => {
            setOpenId(null);
            setLocalVersion((v) => v + 1);
          }}
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
