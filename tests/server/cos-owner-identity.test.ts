/**
 * DISPATCHER's own verification of the owner's folder-ownership bug report
 * (docs/17 row 50) — NOT the writer's fixtures.
 *
 * The bug: ownership was decided by comparing SLUGS, so a folder the caller had
 * created was announced as "another key's" whenever the key's LABEL slugified to
 * something other than the folder's name. The owner hit exactly that with a key
 * he minted and a folder he named `test`.
 *
 * This asserts the rule directly, at the seam the bug lived in, with the shape
 * that broke it: owner id matches, label slugs ELSEWHERE.
 */
import { expect, it } from 'vitest';

import type { WhoAmI } from '@/server/store-client';
import { folderOwnership } from '@/server/store-folders';
import type { FolderRecord } from '@/server/store-files';

function who(id: string, label: string): WhoAmI {
  return {
    id,
    label,
    stores: ['imager'],
    perms: ['read', 'write', 'delete'],
    expiresAt: null,
    lastUsedAt: null,
  };
}

function record(slug: string, owner: string): FolderRecord {
  const stamp = '2026-09-28T00:00:00.000Z';
  return {
    v: 1,
    slug,
    owner,
    displayName: slug,
    private: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

it('COS: the owner’s exact case — folder named `test`, owned by this key, label slugs elsewhere', () => {
  // The key's label produces `label-slugs-elsewhere`, NOT `test`; under the old
  // slug comparison this was reported as another key's folder.
  const me = who('key-local-1', 'label-slugs-elsewhere');
  expect(folderOwnership(record('test', 'key-local-1'), me)).toBe('mine');
});

it('COS: a genuinely foreign folder is still "other"', () => {
  const me = who('key-local-1', 'label-slugs-elsewhere');
  expect(folderOwnership(record('foreign', 'key-local-9'), me)).toBe('other');
});

it('COS: a record with NO owner is "unknown" — never claimed as mine, never blamed on another key', () => {
  const me = who('key-local-1', 'label-slugs-elsewhere');
  expect(folderOwnership(record('ghost', ''), me)).toBe('unknown');
  // A whitespace-only owner is the same absence, not a different key.
  expect(folderOwnership(record('ghost', '   '), me)).toBe('unknown');
});
