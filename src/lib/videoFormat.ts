/**
 * THE video-format seam: which container a block of video bytes is, read from
 * the bytes' own signature (a contractual binary format, not free text) — the
 * video sibling of `src/lib/audioFormat.ts`, sharing its byte compare. The
 * stored type is what the bytes ARE; a payload in no known container THROWS
 * instead of being stored as a video it is not.
 */
import { startsWith } from '@/lib/audioFormat';

export interface VideoFormat {
  mimeType: string;
  extension: string;
}

export const VIDEO_FORMATS = {
  mp4: { mimeType: 'video/mp4', extension: 'mp4' },
  mov: { mimeType: 'video/quicktime', extension: 'mov' },
  webm: { mimeType: 'video/webm', extension: 'webm' },
} as const satisfies Record<string, VideoFormat>;

/**
 * MP4 and QuickTime are ISO base media files: a box size, then `ftyp`, then the
 * major brand (`qt  ` for QuickTime). WebM is Matroska's EBML header
 * `1A 45 DF A3`.
 */
export function sniffVideoFormat(bytes: Uint8Array): VideoFormat {
  if (startsWith(bytes, 'ftyp', 4)) {
    return startsWith(bytes, 'qt  ', 8) ? VIDEO_FORMATS.mov : VIDEO_FORMATS.mp4;
  }
  const [a, b, c, d] = bytes;
  if (a === 0x1a && b === 0x45 && c === 0xdf && d === 0xa3) return VIDEO_FORMATS.webm;
  throw new Error(
    `The video is in no format this app recognises (${String(bytes.length)} bytes, first bytes ${[
      ...bytes.subarray(0, 8),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')})`,
  );
}

/** The extension for a STORED video MIME type; unknown types throw. */
export function videoExtensionFor(mimeType: string): string {
  const found = Object.values(VIDEO_FORMATS).find((format) => format.mimeType === mimeType);
  if (found === undefined) throw new Error(`Unknown video type "${mimeType}"`);
  return found.extension;
}
