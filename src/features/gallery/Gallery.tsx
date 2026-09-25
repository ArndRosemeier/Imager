import { useEffect, useState } from 'react';

import { deleteImage, getRun, listImages } from '@/db/imageRepo';
import { extensionFor, type Run, type StoredImage } from '@/domain/image';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

function Thumb({ image, onOpen }: { image: StoredImage; onOpen: () => void }): React.JSX.Element {
  const url = useImageUrl(image);
  return (
    <figure className="flex flex-col gap-1">
      <button type="button" onClick={onOpen} aria-label={`Open image: ${image.prompt}`}>
        {url !== null && (
          <img src={url} alt={image.prompt} className="aspect-square w-full rounded object-cover" />
        )}
      </button>
      <figcaption className="text-xs">
        <span className="line-clamp-2">{image.prompt}</span>
        <span className="block font-mono text-muted">{image.model}</span>
      </figcaption>
    </figure>
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
        <p>{image.prompt}</p>
        <p className="font-mono text-sm">{image.model}</p>
        <p className="text-sm">
          {new Date(image.createdAt).toLocaleString()} · {image.width}×{image.height} · run cost{' '}
          {run?.costUsd == null ? 'not reported' : `$${run.costUsd.toFixed(4)}`}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {url !== null && (
            <a
              className="rounded bg-accent px-3 py-1 text-on-accent"
              href={url}
              download={`imager-${image.id}.${extensionFor(image.mimeType)}`}
            >
              Download
            </a>
          )}
          {props.onRefine !== undefined && (
            <button type="button" className="rounded bg-accent px-3 py-1 text-on-accent" onClick={props.onRefine}>
              Refine this
            </button>
          )}
          {props.onChat !== undefined && (
            <button type="button" className="rounded bg-accent px-3 py-1 text-on-accent" onClick={props.onChat}>
              Chat with this image
            </button>
          )}
          <button
            type="button"
            className="rounded bg-danger px-3 py-1 text-on-accent"
            onClick={onDelete}
          >
            Delete
          </button>
          <button type="button" className="rounded border border-strong px-3 py-1" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Newest-first grid; `version` bumps re-read the table. */
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
  if (images === null) return <p>Loading gallery…</p>;
  const open = images.find((i) => i.id === openId);
  return (
    <section aria-label="Gallery" className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Gallery</h2>
      {images.length === 0 && <p>No images yet.</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
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
