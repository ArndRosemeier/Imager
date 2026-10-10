import { encodeCanvasAs, type EncodedBytes } from '@/features/refine/reference';

/** How long the browser may take to load and seek a stored video. */
const FRAME_TIMEOUT_MS = 20_000;

/** Seconds before the end that count as "the last frame" (the exact end may be past it). */
const END_OFFSET_S = 0.05;

function once(video: HTMLVideoElement, event: 'loadedmetadata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The video did not finish loading in ${String(FRAME_TIMEOUT_MS / 1000)}s.`));
    }, FRAME_TIMEOUT_MS);
    const onDone = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(
        new Error(
          `This browser cannot decode the video${video.error === null ? '' : ` (${video.error.message || `code ${String(video.error.code)}`})`}.`,
        ),
      );
    };
    function cleanup(): void {
      clearTimeout(timer);
      video.removeEventListener(event, onDone);
      video.removeEventListener('error', onError);
    }
    video.addEventListener(event, onDone);
    video.addEventListener('error', onError);
  });
}

/**
 * The LAST frame of a stored video, as PNG bytes at the video's own size — the
 * "continue a video" source (docs/17 row 58). OpenRouter's video API takes no
 * video input, so a continuation starts from this frame instead. `url` is the
 * object URL the video card already owns (`useObjectUrl`). Every failure
 * (undecodable video, no duration, a stalled load, no encoder) THROWS.
 */
export async function lastFrameOf(url: string): Promise<EncodedBytes> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  const loaded = once(video, 'loadedmetadata');
  video.src = url;
  await loaded;
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error('The video reports no duration, so its last frame cannot be found.');
  }
  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error('The video reports no picture size.');
  }
  const seeked = once(video, 'seeked');
  video.currentTime = Math.max(0, video.duration - END_OFFSET_S);
  await seeked;
  return encodeCanvasAs(video, { width: video.videoWidth, height: video.videoHeight }, 'image/png', 1);
}
