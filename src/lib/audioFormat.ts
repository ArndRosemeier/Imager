/**
 * THE audio-format seam: which container a block of audio bytes is, read from
 * the bytes' own signature (a contractual binary format, not free text), with
 * the MIME type and file extension that belong to it. The music path asks for
 * a format and VERIFIES the bytes are that format, so a provider that quietly
 * returns something else fails loudly instead of being stored under the wrong
 * type (the same discipline as the store encoder's verified blob type).
 */

export interface AudioFormat {
  /** The short name the API's `audio.format` takes. */
  name: 'mp3' | 'wav' | 'flac' | 'ogg';
  mimeType: string;
  extension: string;
}

export const AUDIO_FORMATS = {
  mp3: { name: 'mp3', mimeType: 'audio/mpeg', extension: 'mp3' },
  wav: { name: 'wav', mimeType: 'audio/wav', extension: 'wav' },
  flac: { name: 'flac', mimeType: 'audio/flac', extension: 'flac' },
  ogg: { name: 'ogg', mimeType: 'audio/ogg', extension: 'ogg' },
} as const satisfies Record<string, AudioFormat>;

function startsWith(bytes: Uint8Array, ascii: string, offset = 0): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The format the bytes ARE. An MP3 starts with an ID3 tag or an MPEG frame
 * sync (11 set bits); WAV is `RIFF....WAVE`; FLAC is `fLaC`; Ogg is `OggS`.
 * Anything else THROWS — an unrecognised payload is never stored as audio.
 */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat {
  if (startsWith(bytes, 'ID3')) return AUDIO_FORMATS.mp3;
  const [first, second] = bytes;
  if (first === 0xff && second !== undefined && (second & 0xe0) === 0xe0) return AUDIO_FORMATS.mp3;
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WAVE', 8)) return AUDIO_FORMATS.wav;
  if (startsWith(bytes, 'fLaC')) return AUDIO_FORMATS.flac;
  if (startsWith(bytes, 'OggS')) return AUDIO_FORMATS.ogg;
  throw new Error(
    `The audio is in no format this app recognises (${String(bytes.length)} bytes, first bytes ${[
      ...bytes.subarray(0, 4),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')})`,
  );
}

/** The extension for a STORED audio MIME type; unknown types throw. */
export function audioExtensionFor(mimeType: string): string {
  const found = Object.values(AUDIO_FORMATS).find((format) => format.mimeType === mimeType);
  if (found === undefined) throw new Error(`Unknown audio type "${mimeType}"`);
  return found.extension;
}
