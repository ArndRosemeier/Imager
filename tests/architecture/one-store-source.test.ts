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
