import type { StoredSong } from '@/domain/music';
import { FILE_NAME_ID_STUB_CHARS, sanitizeFileName } from '@/features/export/exportLibrary';
import { audioExtensionFor } from '@/lib/audioFormat';

/**
 * The owner-facing file name for one song: its title through the ONE
 * filename sanitizer, an id stub (two takes of one sheet share a title), and
 * the extension of the format the bytes ARE.
 */
export function songFileName(song: StoredSong): string {
  const stem = sanitizeFileName(song.title, 'song');
  const stub = sanitizeFileName(song.id, 'id').slice(0, FILE_NAME_ID_STUB_CHARS);
  return `${stem}-${stub}.${audioExtensionFor(song.mimeType)}`;
}
