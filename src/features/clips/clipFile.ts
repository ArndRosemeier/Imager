import type { StoredClip } from '@/domain/clip';
import { FILE_NAME_ID_STUB_CHARS, sanitizeFileName } from '@/features/export/exportLibrary';
import { audioExtensionFor } from '@/lib/audioFormat';

/**
 * The owner-facing file name for one clip: its text through the ONE filename
 * sanitizer, an id stub (two clips of one text never collide), and the
 * extension of the format the bytes ARE.
 */
export function clipFileName(clip: StoredClip): string {
  const stem = sanitizeFileName(clip.request.text, clip.kind);
  const stub = sanitizeFileName(clip.id, 'id').slice(0, FILE_NAME_ID_STUB_CHARS);
  return `${stem}-${stub}.${audioExtensionFor(clip.mimeType)}`;
}
