import { useCallback, useEffect, useRef, useState } from 'react';

import { EmptyState, SaveButton } from '@/components/ui';
import { buttonClass, focusRing } from '@/components/styles';
import { getImage, listImages, saveUploadedImage } from '@/db/imageRepo';
import { deleteVideo, deleteVideoJob, listVideoJobs, listVideos, putVideoJob } from '@/db/videoRepo';
import type { StoredImage } from '@/domain/image';
import { isActiveJob, type StoredVideo, type VideoJob, type VideoRequest } from '@/domain/video';
import { useImageUrl } from '@/features/gallery/useImageUrl';
import { lastFrameOf } from '@/features/videos/lastFrame';
import { checkVideoJob, startVideo } from '@/features/videos/runVideo';
import { videoFileName } from '@/features/videos/videoFile';
import {
  selectedVideoModel,
  useVideoPanel,
  videoBlockReason,
  type VideoPanelState,
} from '@/features/videos/useVideos';
import {
  acceptsFirstFrame,
  acceptsLastFrame,
  canGenerateVideoAudio,
  type VideoModel,
} from '@/llm/video';
import { toError } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';
import { useObjectUrl } from '@/lib/useObjectUrl';

/**
 * How often a running job is polled. OpenRouter's own guide polls every 30 s
 * for jobs that take "thirty seconds to a few minutes"; 15 s halves the wait
 * after a short job without hammering the endpoint.
 */
export const VIDEO_POLL_INTERVAL_MS = 15_000;

function formatCost(usd: number | null): string {
  return usd === null ? 'cost not reported' : `$${usd.toFixed(4)}`;
}

/** The options a request was made with, in one line ("model default" when unset). */
function requestSummary(request: VideoRequest): string {
  return [
    request.duration === null ? 'default length' : `${String(request.duration)} s`,
    request.resolution ?? 'default resolution',
    request.aspectRatio ?? 'default aspect',
    request.generateAudio === null ? null : request.generateAudio ? 'with audio' : 'no audio',
    request.firstFrameImageId === null ? null : 'from a start image',
    request.lastFrameImageId === null ? null : 'to an end image',
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** A one-shot request to stage an image as the start image; the nonce makes a repeat a new request. */
interface StartImageRequest {
  imageId: string;
  nonce: number;
}

/** What the picked model can start from, in one sentence. */
function sourceLine(model: VideoModel): string {
  const start = acceptsFirstFrame(model);
  const end = acceptsLastFrame(model);
  if (start && end) return 'This model takes text, plus an optional start image and/or end image.';
  if (start) return 'This model takes text, plus an optional start image (no end image).';
  if (end) return 'This model takes text, plus an optional end image (no start image).';
  return 'This model takes text only (no start or end image).';
}

/* ------------------------------------------------------------ the form */

/** A select whose empty option means "not sent: the model decides". */
function OptionSelect({
  label,
  values,
  value,
  onChange,
  format = (v) => v,
}: Readonly<{
  label: string;
  values: readonly string[];
  value: string;
  onChange: (value: string) => void;
  format?: (value: string) => string;
}>): React.JSX.Element {
  return (
    <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
      <span className="text-label text-ink">{label}</span>
      <select
        className="field focus-visible:field-focus hover:field-hover"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">Model default</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {format(v)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ImageChoice({
  image,
  selected,
  which,
  onPick,
}: Readonly<{
  image: StoredImage;
  selected: boolean;
  which: string;
  onPick: () => void;
}>): React.JSX.Element {
  const url = useImageUrl(image);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Use as ${which}: ${image.prompt}`}
      className={`aspect-square overflow-hidden rounded-md bg-subtle ${focusRing} ${
        selected ? 'ring-2 ring-accent' : ''
      }`}
      onClick={onPick}
    >
      {url !== null && <img src={url} alt="" className="h-full w-full object-cover" />}
    </button>
  );
}

/**
 * An optional frame image from the gallery: the start image (`first_frame`) or
 * the end image (`last_frame`). Each is offered only when the picked model
 * lists that frame type among its supported frame images.
 */
function FramePicker({
  which,
  imageId,
  onChange,
}: Readonly<{
  /** "start image" or "end image" — the label, and the accessible names. */
  which: string;
  imageId: string | null;
  onChange: (id: string | null) => void;
}>): React.JSX.Element {
  const [images, setImages] = useState<StoredImage[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<StoredImage | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open || images !== null) return;
    listImages().then(setImages, (error: unknown) => {
      setLoadError(toError(error));
    });
  }, [open, images]);

  useEffect(() => {
    if (imageId === null) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    getImage(imageId).then(
      (image) => {
        if (!cancelled) setSelected(image ?? null);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(toError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  if (loadError !== null) throw loadError;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-label text-ink">
        {which.charAt(0).toUpperCase() + which.slice(1)} (optional)
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {selected !== null && <SelectedFrame image={selected} which={which} />}
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {open ? 'Close the gallery' : selected === null ? `Choose the ${which}…` : `Change the ${which}…`}
        </button>
        {selected !== null && (
          <button
            type="button"
            aria-label={`Remove the ${which}`}
            className={buttonClass('ghost', focusRing)}
            onClick={() => {
              onChange(null);
            }}
          >
            Remove
          </button>
        )}
      </div>
      {open &&
        (images === null ? (
          <p className="text-caption text-muted">Loading the gallery…</p>
        ) : images.length === 0 ? (
          <p className="text-caption text-muted">The gallery is empty.</p>
        ) : (
          <div className="grid max-h-64 grid-cols-4 gap-1 overflow-y-auto sm:grid-cols-6">
            {images.map((image) => (
              <ImageChoice
                key={image.id}
                image={image}
                selected={image.id === imageId}
                which={which}
                onPick={() => {
                  onChange(image.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

function SelectedFrame({
  image,
  which,
}: Readonly<{ image: StoredImage; which: string }>): React.JSX.Element {
  const url = useImageUrl(image);
  return url === null ? (
    <span className="text-caption text-muted">Loading…</span>
  ) : (
    <img
      src={url}
      alt={`${which}: ${image.prompt}`}
      className="h-16 w-16 rounded-md border border-strong object-cover"
    />
  );
}

/**
 * The form. It is keyed by the model in the parent, so a different model starts
 * from a clean form — an option one model supports is never carried into a
 * request to a model that would refuse it.
 */
function VideoForm({
  state,
  model,
  startImage,
  onSubmitted,
}: Readonly<{
  state: VideoPanelState;
  model: VideoModel | undefined;
  /** A one-shot "use this as the start image" (Continue this video). */
  startImage: StartImageRequest | null;
  onSubmitted: () => void;
}>): React.JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState('');
  const [resolution, setResolution] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  // The API's own default for an audio-capable model is ON; the box starts there.
  const [audio, setAudio] = useState(true);
  const [firstFrameId, setFirstFrameId] = useState<string | null>(null);
  const [lastFrameId, setLastFrameId] = useState<string | null>(null);
  useEffect(() => {
    if (startImage === null) return;
    setFirstFrameId(startImage.imageId);
    document.getElementById('video-prompt')?.focus();
  }, [startImage]);
  const [submitting, setSubmitting] = useState(false);
  const blocked = videoBlockReason(state, prompt);

  const submit = (): void => {
    if (model === undefined) return;
    const request: VideoRequest = {
      model: model.id,
      prompt: prompt.trim(),
      duration: duration === '' ? null : Number(duration),
      resolution: resolution === '' ? null : resolution,
      aspectRatio: aspectRatio === '' ? null : aspectRatio,
      generateAudio: canGenerateVideoAudio(model) ? audio : null,
      firstFrameImageId: acceptsFirstFrame(model) ? firstFrameId : null,
      lastFrameImageId: acceptsLastFrame(model) ? lastFrameId : null,
    };
    setSubmitting(true);
    startVideo({ apiKey: state.settings.openRouterApiKey, request })
      .then(
        () => {
          setPrompt('');
          onSubmitted();
        },
        (error: unknown) => {
          toastError('Could not start the video', error);
        },
      )
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <section aria-label="New video" className="card flex flex-col gap-3 p-3">
      <h2 className="text-heading text-ink">New video</h2>
      <p className="text-caption text-muted">
        {model === undefined
          ? 'No video model is ready yet.'
          : `With ${model.name} (${model.id}). Change it in Settings.`}
      </p>
      <label htmlFor="video-prompt" className="text-label text-ink">
        Prompt
      </label>
      <textarea
        id="video-prompt"
        className="field focus-visible:field-focus hover:field-hover"
        rows={4}
        placeholder="A slow dolly shot through a rain-soaked neon street at night…"
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
        }}
      />
      {model !== undefined && (
        <div className="flex flex-wrap gap-2">
          {model.supported_durations !== null && model.supported_durations.length > 0 && (
            <OptionSelect
              label="Length"
              values={model.supported_durations.map(String)}
              value={duration}
              onChange={setDuration}
              format={(v) => `${v} s`}
            />
          )}
          {model.supported_resolutions !== null && model.supported_resolutions.length > 0 && (
            <OptionSelect
              label="Resolution"
              values={model.supported_resolutions}
              value={resolution}
              onChange={setResolution}
            />
          )}
          {model.supported_aspect_ratios !== null && model.supported_aspect_ratios.length > 0 && (
            <OptionSelect
              label="Aspect ratio"
              values={model.supported_aspect_ratios}
              value={aspectRatio}
              onChange={setAspectRatio}
            />
          )}
        </div>
      )}
      {model !== undefined && canGenerateVideoAudio(model) && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className={focusRing}
            checked={audio}
            onChange={(e) => {
              setAudio(e.target.checked);
            }}
          />
          <span className="text-label text-ink">Generate audio with the video</span>
        </label>
      )}
      {model !== undefined && (
        <p className="text-caption text-muted">
          {sourceLine(model)} OpenRouter's video API takes no video as input, so a video cannot be a
          source.
        </p>
      )}
      {model !== undefined && acceptsFirstFrame(model) && (
        <FramePicker which="start image" imageId={firstFrameId} onChange={setFirstFrameId} />
      )}
      {model !== undefined && acceptsLastFrame(model) && (
        <FramePicker which="end image" imageId={lastFrameId} onChange={setLastFrameId} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass('primary', 'px-4 py-2 text-body')}
          disabled={blocked !== null || submitting}
          onClick={submit}
        >
          {submitting ? 'Starting…' : 'Generate video'}
        </button>
        {blocked !== null && !submitting && <span className="text-caption text-muted">{blocked}</span>}
      </div>
      <p className="text-caption text-muted">
        A video takes from half a minute to several minutes. It is saved here as soon as it starts,
        so you can leave this tab; it is checked and downloaded whenever the Videos tab is open.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------ the lists */

function JobRow({
  job,
  onRetry,
  onDismiss,
}: Readonly<{ job: VideoJob; onRetry: () => void; onDismiss: () => void }>): React.JSX.Element {
  const failed = job.status === 'failed';
  return (
    <li className="card flex flex-col gap-1 p-3">
      <p className="line-clamp-2 text-body text-ink">{job.request.prompt}</p>
      <p className="text-caption text-muted">
        <span className="font-mono">{job.request.model}</span> · {requestSummary(job.request)} ·
        started {new Date(job.createdAt).toLocaleString()}
      </p>
      {failed ? (
        <>
          <p role="alert" className="text-caption text-danger">
            Failed: {job.error ?? 'no reason given'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass('secondary')} onClick={onRetry}>
              Check again
            </button>
            <button type="button" className={buttonClass('ghost', focusRing)} onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <p role="status" className="text-caption text-muted">
          {job.status === 'pending' ? 'Queued at OpenRouter…' : 'Generating…'}
        </p>
      )}
    </li>
  );
}

/**
 * "Continue this video" (docs/17 row 58): OpenRouter takes no video input, so
 * the continuation starts from the video's LAST FRAME — saved to the gallery
 * (where it stays reusable) and staged as the form's start image.
 */
function ContinueButton({
  video,
  url,
  blocked,
  onContinue,
}: Readonly<{
  video: StoredVideo;
  url: string | null;
  blocked: string | null;
  onContinue: (imageId: string) => void;
}>): React.JSX.Element {
  const [working, setWorking] = useState(false);
  return (
    <>
      <button
        type="button"
        className={buttonClass('secondary')}
        disabled={url === null || blocked !== null || working}
        title={blocked ?? undefined}
        onClick={() => {
          if (url === null) return;
          setWorking(true);
          lastFrameOf(url)
            .then((frame) =>
              saveUploadedImage({
                bytes: frame.bytes,
                mimeType: frame.mimeType,
                fileName: `Last frame of: ${video.request.prompt}`,
              }),
            )
            .then(
              (image) => {
                onContinue(image.id);
                toastSuccess('Last frame set as the start image', 'It is saved in the gallery too.');
              },
              (error: unknown) => {
                toastError('Could not take the last frame of the video', error);
              },
            )
            .finally(() => {
              setWorking(false);
            });
        }}
      >
        {working ? 'Taking the last frame…' : 'Continue this video'}
      </button>
      {blocked !== null && <span className="text-caption text-muted">{blocked}</span>}
    </>
  );
}

function VideoCard({
  video,
  continueBlocked,
  onContinue,
  onDeleted,
}: Readonly<{
  video: StoredVideo;
  continueBlocked: string | null;
  onContinue: (imageId: string) => void;
  onDeleted: () => void;
}>): React.JSX.Element {
  const url = useObjectUrl(video.bytes, video.mimeType);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="card flex flex-col gap-2 p-3">
      {url === null ? (
        <p className="text-caption text-muted">Loading video…</p>
      ) : (
        <video
          controls
          src={url}
          aria-label={`Play: ${video.request.prompt}`}
          className="w-full rounded-md bg-canvas"
        />
      )}
      <p className="text-body whitespace-pre-wrap text-ink">{video.request.prompt}</p>
      <p className="text-caption text-muted">
        <span className="font-mono">{video.request.model}</span> · {requestSummary(video.request)} ·{' '}
        {formatCost(video.costUsd)} · {new Date(video.createdAt).toLocaleString()}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SaveButton
          label="Download"
          buildRequest={() => ({
            fileName: videoFileName(video),
            mimeType: video.mimeType,
            buildBytes: () => video.bytes,
          })}
        />
        <ContinueButton video={video} url={url} blocked={continueBlocked} onContinue={onContinue} />
        {confirming ? (
          <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-ink">Delete this video?</span>
            <button
              type="button"
              className={buttonClass('danger')}
              onClick={() => {
                deleteVideo(video.id).then(onDeleted, (error: unknown) => {
                  toastError('Could not delete the video', error);
                });
              }}
            >
              Yes, delete
            </button>
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={buttonClass('danger')}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The Videos tab (docs/17 row 56): the form, the jobs OpenRouter is still
 * working on (or that failed, with their reason), and the finished videos —
 * each with its player, Download and Delete.
 *
 * WHILE THIS TAB IS OPEN it polls every running job; a job started earlier (a
 * tab switch, a reload) is picked up again on the first tick, so nothing paid
 * for is lost by leaving.
 */
export function VideosArea({
  pollIntervalMs = VIDEO_POLL_INTERVAL_MS,
}: Readonly<{ pollIntervalMs?: number }>): React.JSX.Element {
  const { state, error } = useVideoPanel();
  const [jobs, setJobs] = useState<VideoJob[] | null>(null);
  const [videos, setVideos] = useState<StoredVideo[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [startImage, setStartImage] = useState<StartImageRequest | null>(null);
  const polledOnce = useRef(false);
  // One tick at a time: a stale second check could otherwise write a job back
  // after the first one had already turned it into a video.
  const ticking = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback((): void => {
    Promise.all([listVideoJobs(), listVideos()]).then(
      ([jobRows, videoRows]) => {
        if (!mounted.current) return;
        setJobs(jobRows);
        setVideos(videoRows);
      },
      (failure: unknown) => {
        if (mounted.current) setLoadError(toError(failure));
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const apiKey = state?.settings.openRouterApiKey ?? '';
  // The poller: one tick per change of the job list. Each tick checks every
  // running job, stores what it learned, and reloads — which schedules the
  // next tick while anything is still running.
  useEffect(() => {
    if (jobs === null || apiKey === '') return;
    const active = jobs.filter(isActiveJob);
    if (active.length === 0) return;
    const delay = polledOnce.current ? pollIntervalMs : 0;
    const timer = setTimeout(() => {
      if (ticking.current) return;
      ticking.current = true;
      polledOnce.current = true;
      Promise.all(active.map((job) => checkVideoJob(apiKey, job)))
        .then(
          (outcomes) => {
            if (!mounted.current) return;
            const done = outcomes.filter((o) => o === 'completed').length;
            const failed = outcomes.filter((o) => o === 'failed').length;
            if (done > 0) toastSuccess(done === 1 ? 'Your video is ready' : `${String(done)} videos are ready`);
            if (failed > 0) toastError(failed === 1 ? 'A video job failed' : `${String(failed)} video jobs failed`, 'The reason is shown on the Videos tab.');
          },
          (failure: unknown) => {
            // Only reachable when storing a check's result failed.
            toastError('Could not store the video job status', failure);
          },
        )
        .finally(() => {
          ticking.current = false;
          reload();
        });
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [jobs, apiKey, pollIntervalMs, reload]);

  if (error !== null) throw error;
  if (loadError !== null) throw loadError;
  if (state === null || jobs === null || videos === null) {
    return <p className="text-body text-muted">Loading videos…</p>;
  }

  const model = selectedVideoModel(state);
  const newestFirst = [...videos].reverse();
  const continueBlocked =
    model === undefined
      ? 'Pick a video model in Settings to continue a video.'
      : acceptsFirstFrame(model)
        ? null
        : `${model.name} takes no start image, so it cannot continue a video.`;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
      <VideoForm
        key={model?.id ?? ''}
        state={state}
        model={model}
        startImage={startImage}
        onSubmitted={reload}
      />
      <div className="flex min-w-0 flex-col gap-3">
        {jobs.length > 0 && (
          <section aria-label="Video jobs" className="flex flex-col gap-2">
            <h2 className="text-heading text-ink">In progress</h2>
            <ul className="flex flex-col gap-2">
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onRetry={() => {
                    putVideoJob({ ...job, status: 'pending', error: null }).then(reload, (failure: unknown) => {
                      toastError('Could not retry the video job', failure);
                    });
                  }}
                  onDismiss={() => {
                    deleteVideoJob(job.id).then(reload, (failure: unknown) => {
                      toastError('Could not dismiss the video job', failure);
                    });
                  }}
                />
              ))}
            </ul>
          </section>
        )}
        <section aria-label="Videos" className="flex flex-col gap-2">
          <h2 className="text-heading text-ink">Videos</h2>
          {newestFirst.length === 0 ? (
            <EmptyState
              title="No videos yet."
              hint="Describe a scene in the form — camera movement, subject, light, mood."
            />
          ) : (
            <ul className="grid gap-3 xl:grid-cols-2">
              {newestFirst.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  continueBlocked={continueBlocked}
                  onContinue={(imageId) => {
                    setStartImage((prev) => ({ imageId, nonce: (prev?.nonce ?? 0) + 1 }));
                  }}
                  onDeleted={reload}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
