import { useEffect, useRef, useState } from 'react';

import { buttonClass } from '@/components/styles';
import { getImage, saveUploadedImage } from '@/db/imageRepo';
import type { Run, StoredImage } from '@/domain/image';
import { RunStatus } from '@/features/generate/RunStatus';
import { runGeneration } from '@/features/generate/runGeneration';
import { refineBlockReason, useImagePanel } from '@/features/generate/useImagePanel';
import { IMAGE_ACCEPT } from '@/features/refine/reference';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/** The source thumbnail, resolved from the selected stored image. */
function SourcePreview({ image }: Readonly<{ image: StoredImage }>): React.JSX.Element {
  const url = useImageUrl(image);
  return (
    <figure className="flex flex-col gap-1">
      {url !== null && (
        <img
          src={url}
          alt={`Refinement source: ${image.prompt}`}
          className="max-h-40 w-full rounded-md border border-strong bg-canvas object-contain"
        />
      )}
      <figcaption className="text-caption text-muted">
        {image.width}×{image.height} · {image.source}
      </figcaption>
    </figure>
  );
}

/**
 * The refinement form (slice 3, Images API): pick a gallery image or upload
 * one, give a free-text instruction, get refined images into the SAME gallery.
 *
 * The instruction is FREE TEXT sent to the model verbatim — never parsed,
 * matched or interpreted here (AGENTS rule 5). The request path is the shared
 * `runGeneration` → `src/llm/images.ts`; this panel only prepares input.
 */
export function RefinePanel({
  sourceId,
  onSourceChange,
  onFinished,
}: Readonly<{
  sourceId: string | null;
  onSourceChange: (id: string | null) => void;
  onFinished: () => void;
}>): React.JSX.Element {
  const { state, error } = useImagePanel();
  const [source, setSource] = useState<StoredImage | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort(new DOMException('Refinement cancelled', 'AbortError'));
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (sourceId === null) {
      setSource(null);
      return;
    }
    getImage(sourceId).then(
      (image) => {
        if (!cancelled) setSource(image ?? null);
      },
      (loadError: unknown) => {
        if (!cancelled) {
          setUploadError(errorMessage(loadError));
          toastError('Could not load the refinement source', loadError);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  if (error !== null) throw error;
  if (state === null) return <p className="text-body text-muted">Loading settings…</p>;

  const reason =
    source === null ? 'Choose or upload an image to refine' : refineBlockReason(state, instruction);

  const onUpload = async (file: File): Promise<void> => {
    setUploadError(null);
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = await saveUploadedImage({
        bytes,
        mimeType: file.type,
        fileName: file.name,
      });
      onSourceChange(image.id);
      // The upload is a gallery row now: refresh the gallery so it is visible
      // and reusable there immediately.
      onFinished();
    } catch (uploadFailure: unknown) {
      setUploadError(errorMessage(uploadFailure));
      toastError('Could not use that file as a refinement source', uploadFailure);
    } finally {
      setUploading(false);
    }
  };

  const onRefine = (): void => {
    if (source === null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setLastRun(null);
    runGeneration({
      apiKey: state.settings.openRouterApiKey,
      // The owner's refinement model when picked, else the image model
      // (ledger row 11).
      model: state.refineModel,
      prompt: instruction.trim(),
      // A refinement is one output image: the refinement is the source itself,
      // so a multi-image response would be N near-duplicates of one result.
      n: 1,
      inputImageIds: [source.id],
      signal: controller.signal,
    })
      .then(setLastRun, (runError: unknown) => {
        toastError('Refinement failed', runError);
        setLastRun({
          id: 'failed',
          kind: 'refine',
          prompt: instruction.trim(),
          model: state.refineModel,
          inputImageIds: [source.id],
          requestedCount: 1,
          receivedCount: 0,
          filteredCount: 0,
          costUsd: null,
          createdAt: Date.now(),
          error: errorMessage(runError),
        });
      })
      .finally(() => {
        setBusy(false);
        abortRef.current = null;
        onFinished();
      });
  };

  return (
    <section aria-label="Refine" className="flex flex-col gap-2">
      <p className="truncate font-mono text-caption text-muted">
        {state.refineModel === '' ? 'No model selected' : state.refineModel}
      </p>
      {state.settings.refineChatModel === '' && state.refineModel !== '' && (
        <p className="text-caption text-muted">
          The refinement model is unset, so this uses the image model — set a refinement model in
          Settings to choose separately.
        </p>
      )}
      {state.refineLimits !== null && state.refineLimits.maxReferences === 0 && (
        <p
          role="alert"
          className="rounded-md border border-warn bg-warn-surface p-2 text-caption text-on-warn-surface"
        >
          This model does not accept reference images — pick another refinement model in Settings to
          refine.
        </p>
      )}

      <h3 className="text-label text-ink">Source image</h3>
      {source === null ? (
        <p className="text-caption text-muted">
          Open an image in the gallery and choose “Refine this”, or upload a file.
        </p>
      ) : (
        <SourcePreview image={source} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${buttonClass('secondary')} cursor-pointer`}>
          Upload an image
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            aria-label="Upload an image"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void onUpload(file);
            }}
          />
        </label>
        {source !== null && (
          <button
            type="button"
            className={buttonClass('ghost')}
            onClick={() => {
              onSourceChange(null);
            }}
          >
            Clear source
          </button>
        )}
      </div>
      {uploading && (
        <p role="status" className="text-caption text-muted">
          Reading the file…
        </p>
      )}
      {uploadError !== null && (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-surface p-2 text-caption text-on-danger-surface"
        >
          Could not use that image: {uploadError}
        </p>
      )}

      <label htmlFor="refine-instruction" className="text-label text-ink">
        Instruction
      </label>
      <textarea
        id="refine-instruction"
        className="field focus-visible:field-focus hover:field-hover"
        rows={4}
        placeholder="Change one thing, e.g. “make it night, keep the layout”"
        value={instruction}
        onChange={(e) => {
          setInstruction(e.target.value);
        }}
      />

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass('primary', 'px-4 py-2 text-body')}
          disabled={reason !== null || busy}
          onClick={onRefine}
        >
          {busy ? 'Refining…' : 'Refine'}
        </button>
        {busy && (
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              abortRef.current?.abort(new DOMException('Refinement cancelled', 'AbortError'));
            }}
          >
            Cancel
          </button>
        )}
        {reason !== null && !busy && <span className="text-caption text-muted">{reason}</span>}
      </div>
      <RunStatus run={lastRun} />
    </section>
  );
}
