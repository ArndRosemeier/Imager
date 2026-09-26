/**
 * THE content-hash seam: the ONE place the app computes the SHA-256 that the
 * internal archive format's `images[].sha256` is contracted to carry.
 *
 * The exporter WRITES each image's hash and the importer VERIFIES it, so the two
 * halves must agree byte for byte — a second digest implementation (a different
 * encoding, a different algorithm, a hex-vs-base64 slip) would make every
 * legitimate backup fail its own integrity check, or worse, make a tampered one
 * pass. One seam, called by both.
 *
 * `lib.dom` declares `crypto.subtle` as unconditionally present, but it needs a
 * SECURE CONTEXT (https or localhost) and is genuinely absent elsewhere — and a
 * hash that silently did not happen would let an import trust bytes nobody
 * verified (rule 1), so the absence is a LOUD throw. The API is read through a
 * widened structural type for the same reason as the clipboard/save seams: the
 * compiler must not narrow the guard away.
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const cryptoApi = globalThis.crypto as {
    subtle?: { digest: (algorithm: string, data: BufferSource) => Promise<ArrayBuffer> };
  };
  if (cryptoApi.subtle === undefined) {
    throw new Error(
      'Web Crypto (crypto.subtle) is unavailable in this browser context (it requires a secure https:// page or localhost) — the archive cannot be integrity-checked.',
    );
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
