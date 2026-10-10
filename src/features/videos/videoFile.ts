import type { StoredVideo } from '@/domain/video';
import { FILE_NAME_ID_STUB_CHARS, sanitizeFileName } from '@/features/export/exportLibrary';
import { videoExtensionFor } from '@/lib/videoFormat';

/**
 * The owner-facing file name for one video: its prompt through the ONE
 * filename sanitizer, an id stub (two videos of one prompt never collide), and
 * the extension of the container the bytes ARE.
 */
export function videoFileName(video: StoredVideo): string {
  const stem = sanitizeFileName(video.request.prompt, 'video');
  const stub = sanitizeFileName(video.id, 'id').slice(0, FILE_NAME_ID_STUB_CHARS);
  return `${stem}-${stub}.${videoExtensionFor(video.mimeType)}`;
}
