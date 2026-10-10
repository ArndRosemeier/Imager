import { useEffect, useState } from 'react';

import { listRunImages } from '@/db/imageRepo';
import type { Run, StoredImage } from '@/domain/image';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { toastError } from '@/lib/toast';

function ResultImage({ image }: Readonly<{ image: StoredImage }>): React.JSX.Element {
  const url = useImageUrl(image);
  return (
    <figure className="overflow-hidden rounded-md border border-strong bg-canvas">
      {url !== null && (
        <img
          src={url}
          alt={`Result: ${image.prompt}`}
          className="max-h-[70vh] w-full object-contain"
        />
      )}
    </figure>
  );
}

/** The images a successful run stored, read back from the library by run id. */
function RunImages({ runId }: Readonly<{ runId: string }>): React.JSX.Element | null {
  const [images, setImages] = useState<readonly StoredImage[]>([]);
  useEffect(() => {
    let cancelled = false;
    setImages([]);
    listRunImages(runId).then(
      (found) => {
        if (!cancelled) setImages(found);
      },
      (error: unknown) => {
        if (!cancelled) toastError('Could not load the result images', error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (images.length === 0) return null;
  return (
    <div
      aria-label="Latest result"
      role="group"
      className={`grid gap-2 ${images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
    >
      {images.map((image) => (
        <ResultImage key={image.id} image={image} />
      ))}
    </div>
  );
}

/**
 * The one result surface for a run (create or refine): the images it stored,
 * then counts, the filtered candidates the API dropped, and the cost, or the
 * run's failure message. Extracted so the two panels cannot drift on how a
 * result is reported (rule 4).
 */
export function RunStatus({ run }: Readonly<{ run: Run | null }>): React.JSX.Element | null {
  if (run === null) return null;
  return (
    <>
      <p role="status" className={`text-caption ${run.error === null ? 'text-ok' : 'text-danger'}`}>
        {run.error === null ? (
          <>
            Received {run.receivedCount} of {run.requestedCount}.{' '}
            {run.filteredCount > 0 &&
              `${String(run.filteredCount)} of ${String(run.receivedCount + run.filteredCount)} candidates were filtered. `}
            Cost: {run.costUsd === null ? 'not reported' : `$${run.costUsd.toFixed(4)}`}
          </>
        ) : (
          <>Run failed: {run.error}</>
        )}
      </p>
      {run.error === null && run.receivedCount > 0 && <RunImages runId={run.id} />}
    </>
  );
}
