import { expect, it } from 'vitest';

import { bytesFromBase64 } from '@/lib/base64';
import {
  OBJECT_VERSION,
  buildImageObject,
  emptyFolderIndex,
  folderIndexSchema,
  folderObjectName,
  formatSeq,
  imageObjectName,
  indexObjectName,
  parseImageObject,
  parseObjectName,
  slugFromLabel,
  type ImageHeader,
} from '@/server/store-files';

/**
 * docs/17 row 42 — the object model's NAME GRAMMAR and the wire codec for one
 * image. Pure functions, no network: the real transport is exercised in
 * `tests/server/store-flow.test.ts` against a fake of the documented contract.
 */

const HEADER: ImageHeader = {
  v: OBJECT_VERSION,
  id: 'img-1',
  folder: 'alice',
  tags: ['orc', 'forest'],
  prompt: 'an orc in a forest',
  model: 'google/gemini-2.5-flash-image',
  source: 'generated',
  createdAt: '2026-09-28T00:00:00.000Z',
  width: 1536,
  height: 1024,
  mimeType: 'image/webp',
  quality: 90,
};

const BYTES = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 34, 92]);

it('the name grammar is the API rule: one segment, lowercase, dash-encoded', () => {
  expect(folderObjectName('alice')).toBe('folder-alice');
  expect(indexObjectName('alice')).toBe('folder-alice-index');
  expect(imageObjectName('alice', 1)).toBe('i-alice-000001');
  expect(imageObjectName('alice', 123456)).toBe('i-alice-123456');
  expect(formatSeq(7)).toBe('000007');
  // A slug has NO subfolders: a slash, an uppercase letter, a space or a
  // leading dot is REFUSED rather than sanitised into another name (the API's
  // own contract: `400 invalid_name`, never a renamed object).
  for (const bad of ['Alice', 'a/b', 'a b', '.hidden', '', 'x'.repeat(41)]) {
    expect(() => folderObjectName(bad)).toThrow(/not a legal folder slug/);
  }
  expect(() => formatSeq(0)).toThrow(/outside/);
  expect(() => formatSeq(10 ** 6)).toThrow(/outside/);
});

it('an object name is classified by its own family, and a foreign name is not an error', () => {
  expect(parseObjectName('folder-alice')).toEqual({ kind: 'folder', slug: 'alice' });
  expect(parseObjectName('folder-alice-index')).toEqual({ kind: 'index', slug: 'alice' });
  expect(parseObjectName('i-alice-000001')).toEqual({ kind: 'image', slug: 'alice' });
  // A hyphen inside the slug is fine: the sequence is the LAST segment.
  expect(parseObjectName('i-my-folder-000012')).toEqual({ kind: 'image', slug: 'my-folder' });
  // Someone else's object: ignored, never reported as a corrupt folder.
  expect(parseObjectName('notes.txt')).toBeNull();
  expect(parseObjectName('i-alice-1')).toBeNull();
  expect(parseObjectName('i-ALICE-000001')).toBeNull();
});

it('one PUT round-trips the header AND the exact bytes, with the payload LAST', () => {
  const text = buildImageObject(HEADER, BYTES);
  // The payload is the last field, unescaped: base64 never contains a quote or
  // a newline, which is what makes the anchor safe.
  expect(text.trimEnd().endsWith('\n}')).toBe(true);
  expect(text.lastIndexOf('"body": "')).toBeGreaterThan(text.indexOf('"quality"'));
  const parsed = parseImageObject(text);
  expect(parsed.bytes).toEqual(BYTES);
  expect(parsed.body).toBe(btoa(String.fromCharCode(...BYTES)));
  expect(parsed.tags).toEqual(['orc', 'forest']);
  expect(parsed.quality).toBe(90);
  expect(parsed.width).toBe(1536);
  expect(parsed.height).toBe(1024);
  // Byte-exactness is the point: decode the payload through the app's own seam.
  expect(bytesFromBase64(parsed.body)).toEqual(BYTES);
});

it('a corrupt image object is a LOUD error, never a half-read picture', () => {
  const good = buildImageObject(HEADER, BYTES);
  // No body field at all.
  expect(() => parseImageObject('{"v":1,"id":"x"}')).toThrow(/no trailing base64/);
  // A header that fails the schema (quality is required and bounded).
  // A malformed header cannot even be WRITTEN (validated before serialising).
  expect(() => buildImageObject({ ...HEADER, quality: 900 }, BYTES)).toThrow(
    /malformed image header/,
  );
  const otherHeader = buildImageObject({ ...HEADER, width: 1 }, BYTES);
  expect(parseImageObject(otherHeader).width).toBe(1);
  // A body that is not base64.
  const truncated = good.slice(0, good.length - 4) + '!!!!"\n}';
  expect(() => parseImageObject(truncated)).toThrow(/corrupt|decode/);
});

it('an empty payload is refused: the store never creates an empty object', () => {
  expect(() => buildImageObject(HEADER, new Uint8Array(0))).toThrow(/empty image payload/);
});

it('a folder slug from a label is an encoder, never a parser', () => {
  expect(slugFromLabel('Alice A.', 'user-key1')).toBe('alice-a');
  expect(slugFromLabel('  TOM  ', 'user-key1')).toBe('tom');
  expect(slugFromLabel('!!!', 'user-key1')).toBe('user-key1');
  expect(slugFromLabel('a'.repeat(80), 'user-key1')).toHaveLength(40);
  // Nothing usable in the label AND nothing usable in the fallback is a LOUD
  // error: a silently invented name would create a folder nobody asked for.
  expect(() => slugFromLabel('!!!', '!!!')).toThrow(/folder name/);
});

it('a fresh folder index is empty with the first sequence free', () => {
  const index = emptyFolderIndex('alice');
  expect(folderIndexSchema.parse(index)).toEqual({
    v: 1,
    slug: 'alice',
    nextSeq: 1,
    images: [],
  });
});
