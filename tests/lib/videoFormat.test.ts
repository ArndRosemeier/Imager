import { expect, it } from 'vitest';

import { sniffVideoFormat, videoExtensionFor } from '@/lib/videoFormat';

const ascii = (text: string): number[] => Array.from(new TextEncoder().encode(text));

it('types video bytes by their own signature', () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x20, ...ascii('ftypisom'), 0, 0]);
  const mov = new Uint8Array([0, 0, 0, 0x14, ...ascii('ftypqt  '), 0, 0]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]);
  expect(sniffVideoFormat(mp4).mimeType).toBe('video/mp4');
  expect(sniffVideoFormat(mov).mimeType).toBe('video/quicktime');
  expect(sniffVideoFormat(webm).mimeType).toBe('video/webm');
  expect(videoExtensionFor('video/mp4')).toBe('mp4');
});

it('refuses bytes in no known container, and unknown stored types', () => {
  expect(() => sniffVideoFormat(new Uint8Array(ascii('{"error":1}')))).toThrow(/no format/);
  expect(() => videoExtensionFor('video/x-unknown')).toThrow(/Unknown video type/);
});
