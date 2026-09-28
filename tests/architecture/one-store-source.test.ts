import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { sourceFiles } from '../helpers';

/**
 * Rule 4 pins for the ServerStore seam (docs/17 row 42).
 *
 * The owner's ask put a SECOND service into the app, and the risk that carries
 * is a second way to talk to it: a component calling `fetch` itself, a feature
 * assembling its own object name, or a second thumbnail downscale. These pins
 * go red when that appears.
 *
 * The seam map (all under `src/server/`):
 *   store-client.ts   the ONLY HTTP transport for the service
 *   store-files.ts    the name grammar + the record schemas + the wire codec
 *   store-folders.ts  listing, indexes, uploads
 *   store-cache.ts    the Dexie cache (thumbnails + originals), hash-validated
 *   store-session.ts  the key, `/whoami`, which folder is "mine"
 *   store-encode.ts   the ONE store-format encoder (WebP q90, verified)
 *
 * ... and the two FEATURE seams the store's two upload entry points share:
 *   src/features/store/storeTransfer.ts  the ONE uploader (`uploadSources`)
 *   src/features/store/selection.ts      the ONE multiselect gesture
 */

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SRC = sourceFiles('src');

const codeByFile = new Map(SRC.map((file) => [file, stripComments(readFileSync(file, 'utf8'))]));

/** Files whose CODE contains `needle`. */
function definers(needle: string): string[] {
  return SRC.filter((file) => (codeByFile.get(file) ?? '').includes(needle));
}

it('exactly ONE module reaches the service — the store client', () => {
  // Only the client seam may call the transport layer.
  const callers = definers('requestRaw(').filter((file) => file !== 'src/server/store-client.ts');
  expect(callers).toEqual([]);
  // And the transport is named as the seam it is.
  expect(readFileSync('src/server/store-client.ts', 'utf8')).toContain('Authorization');
  // No credential ever travels in a URL: the key is a header, and a query
  // string carrying it would land in access logs and history.
  const withKeyInQuery = SRC.filter((file) =>
    /[?&](key|api_key|access_key|token)=/i.test(codeByFile.get(file) ?? ''),
  );
  expect(withKeyInQuery).toEqual([]);
});

it('the object-name grammar has ONE definition', () => {
  expect(definers('export function folderObjectName')).toEqual(['src/server/store-files.ts']);
  expect(definers('export function indexObjectName')).toEqual(['src/server/store-files.ts']);
  expect(definers('export function imageObjectName')).toEqual(['src/server/store-files.ts']);
  expect(definers('export function parseObjectName')).toEqual(['src/server/store-files.ts']);
  // A feature that hand-rolls `i-${...}` would be a second grammar. The
  // grammar module itself is the one legitimate place the prefixes appear.
  const handRolled = SRC.filter(
    (file) =>
      file !== 'src/server/store-files.ts' &&
      /['"`]i-\$\{|['"`]folder-\$\{|['"`]folder-/.test(codeByFile.get(file) ?? ''),
  );
  expect(handRolled).toEqual([]);
});

it('the store encoder has ONE implementation, and it VERIFIES the produced type', () => {
  expect(definers('export async function encodeStoreImage')).toEqual(['src/server/store-encode.ts']);
  expect(definers('export async function encodeThumbnail')).toEqual(['src/server/store-encode.ts']);
  // The substitution check: the produced blob's type must equal the requested
  // one, or nothing is stored (the AVIF trap, generalised). It lives in the
  // ONE shared encoder primitive, which the store's format policy calls.
  const primitive = codeByFile.get('src/features/refine/reference.ts') ?? '';
  expect(primitive).toContain('blob.type !== type');
  const policy = codeByFile.get('src/server/store-encode.ts') ?? '';
  expect(policy).toContain('STORE_IMAGE_MIME_TYPE');
  expect(policy).toContain('EncoderUnavailableError');
  // No second canvas encoder: the ONE encode-and-verify primitive lives in the
  // refinement reference seam, and the store's FORMAT POLICY (type, quality,
  // fallback, thumbnail cap) lives here. `convertToBlob` is the primitive.
  const convertToBlob = definers('convertToBlob').filter(
    (file) => !file.endsWith('.tsx'),
  );
  expect(convertToBlob).toEqual(['src/features/refine/reference.ts']);
});

it('the Dexie cache is the ONLY place store bytes are kept locally', () => {
  const tables = definers('db.storeThumbs');
  const writeTables = definers('db.storeObjects.put');
  expect(tables).toEqual(['src/server/store-cache.ts']);
  expect(writeTables).toEqual(['src/server/store-cache.ts']);
  // A second home for cached store bytes (localStorage, a module-level Map)
  // would defeat the sha256 validation this seam exists for: no other module
  // may touch either cache table.
  const otherTables = SRC.filter(
    (file) =>
      file !== 'src/server/store-cache.ts' &&
      /db\.(storeThumbs|storeObjects)/.test(codeByFile.get(file) ?? ''),
  );
  expect(otherTables).toEqual([]);
});

it('no component calls the transport directly', () => {
  const featureFiles = SRC.filter((file) => file.startsWith('src/features/'));
  expect(featureFiles.length).toBeGreaterThan(0);
  // Components receive a proven connection and go through the feature seams;
  // reaching for a transport function would be a second call path to the
  // service. (Importing the client's CONSTANTS — the default URL, the
  // reachability probe's helper — is fine, so the check names the functions.)
  const offenders = featureFiles.filter((file) =>
    /\b(requestRaw|getObject|putObject|deleteObject|listObjects|whoami)\s*\(/.test(
      codeByFile.get(file) ?? '',
    ),
  );
  expect(offenders).toEqual([]);
});

it('the privacy flag is applied in exactly ONE place', () => {
  expect(definers('export function visibleFolders')).toEqual(['src/server/store-folders.ts']);
  // And the honesty sentence is the same string the app states on screen.
  expect(readFileSync('src/features/store/StoreArea.tsx', 'utf8')).toContain(
    'courtesy between users of Imager, not a lock',
  );
});

it('the two upload entry points share ONE uploader (docs/17 row 45)', () => {
  /*
   * The owner's report was a MISSING capability (local gallery images could not
   * reach the store), not a request for a second uploader. A file from this
   * device and an image from the library are two thin adapters over
   * `uploadSources`; a second encoder/object-writer would be a second place the
   * store format could drift.
   */
  expect(definers('export async function uploadSources')).toEqual([
    'src/features/store/storeTransfer.ts',
  ]);
  const transfer = codeByFile.get('src/features/store/storeTransfer.ts') ?? '';
  expect(transfer).toContain('export async function uploadFiles');
  expect(transfer).toContain('export async function uploadStoredImages');
  // Both adapters call the ONE core (two call sites, one implementation).
  expect(transfer.split('return uploadSources(').length - 1).toBe(2);
  // The encoder and the object writer stay single-site.
  expect(definers('encodeStoreImage(').filter((file) => file !== 'src/server/store-encode.ts')).toEqual(
    ['src/features/store/storeTransfer.ts'],
  );
  // `uploadImage` is DEFINED in the folder seam; the uploader is its only
  // feature caller.
  expect(
    definers('uploadImage(').filter((file) => file !== 'src/server/store-folders.ts'),
  ).toEqual(['src/features/store/storeTransfer.ts']);
});

it('the store pane and the library picker select with ONE gesture (docs/17 row 45)', () => {
  expect(definers('export function nextSelection')).toEqual(['src/features/store/selection.ts']);
  // Both panes go through it; neither re-implements shift-range over its own
  // grid (which is exactly where the two would have drifted).
  const callers = definers('nextSelection(').filter(
    (file) => file !== 'src/features/store/selection.ts',
  );
  expect(callers.sort()).toEqual([
    'src/features/store/FolderDialog.tsx',
    'src/features/store/LibraryPush.tsx',
  ]);
  // And neither pane hand-rolls the shift branch.
  for (const file of callers) {
    expect(codeByFile.get(file) ?? '').not.toContain('shiftKey &&');
  }
});
