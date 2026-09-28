import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';

import { db } from '@/db/db';
import { DEFAULT_SETTINGS } from '@/domain/settings';
import { StoreArea } from '@/features/store/StoreArea';
import type { StoreTarget, WhoAmI } from '@/server/store-client';
import {
  createFolder,
  ensureIndex,
  readDirectory,
  uploadImage,
} from '@/server/store-folders';
import { slugFallbackForKey, slugFromLabel } from '@/server/store-files';

import { FakeServerStore } from '../server/fakeStore';

/**
 * docs/17 row 50 — WHOSE FOLDER IS IT? OWNERSHIP IS THE KEY ID, NEVER A SLUG.
 *
 * THE OWNER'S REPORT, verbatim: *"i minted a key, added an image and it worked,
 * but i got a misleading message: A library push goes into test, which belongs
 * to another key. The store has no per-object permissions, so this works — and
 * its owner will see your images. But i created this folder with the same
 * key."* He was right: `mine` was `folder.record.slug === connection.myFolder`,
 * and `myFolder` was a slug derived from the key's LABEL. His folder was called
 * `test`; his label slugified to something else, so his OWN folder was
 * announced as another key's — a misleading-privacy message about a folder no
 * other user was involved in.
 *
 * The pins below are the three answers the app must be able to give:
 *   * `mine`    — the record's `owner` is the caller's `/whoami` id, EVEN WHEN
 *                 the slug differs from the label-derived name (his exact case);
 *   * `other`   — a genuinely different id still warns, and the warning is kept;
 *   * `unknown` — a record that names NO owner is "cannot tell": never a false
 *                 "another key's", never a false "yours".
 *
 * ... plus the two consumers that inherited the false negative: the folder list
 * the app shows, and the folder the dialog opens on / the destination default.
 */

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Test setup: missing ${what}`);
  return value;
}

/** The caller's key. Its LABEL deliberately slugifies to something that is NOT
 * the folder he created — the exact shape of the owner's report. */
const WHO: WhoAmI = {
  id: 'key-1',
  label: 'Alice The Key',
  stores: ['imager'],
  perms: ['read', 'write', 'delete'],
  expiresAt: null,
  lastUsedAt: null,
};
const OTHER: WhoAmI = { ...WHO, id: 'key-2', label: 'Bob The Other' };

/** What `folderSlugForKey` proposes for WHO's key: the label-derived NAME. */
const PROPOSED = slugFromLabel(WHO.label, slugFallbackForKey(WHO.id));

let store: FakeServerStore;

function target(): StoreTarget {
  return { baseUrl: 'https://store.example', store: 'imager', key: 'ssk_test_KEY' };
}

/**
 * The stored settings. `serverStoreFolder` is the app's PROPOSED folder name:
 * `''` reproduces a first run (the name is derived from the key's label), and
 * `PROPOSED` reproduces the owner's stored state — a proposed name that is NOT
 * the slug of the folder he actually created.
 */
async function seedSettings(serverStoreFolder: string): Promise<void> {
  await db.settings.put({
    ...DEFAULT_SETTINGS,
    id: 'settings',
    serverStoreKey: 'ssk_test_KEY',
    serverStoreFolder,
  });
}

/** One image object written through the app's OWN seam, so the listing and the
 * index are the real ones (no encoder needed: the bytes are a fixture). */
async function seedImage(slug: string, position: number): Promise<void> {
  const directory = await readDirectory(target());
  const listing = must(
    directory.folders.find((folder) => folder.record.slug === slug),
    `the ${slug} folder`,
  );
  const { index } = await ensureIndex(target(), listing, directory.byName);
  await uploadImage(
    target(),
    {
      slug,
      bytes: new Uint8Array([position, 9, 9, 9]),
      mimeType: 'image/webp',
      width: 800,
      height: 600,
      quality: 90,
      prompt: `seeded ${String(position)}`,
      model: 'uploaded file',
      source: 'uploaded',
      tags: [],
      sourceSha256: 'a'.repeat(64),
      id: `seed-${String(position)}`,
      createdAt: new Date(2026, 0, position),
    },
    index,
    directory.entries.map((entry) => entry.name),
  );
}

/** A folder RECORD with NO `owner` at all: another client's (or an older
 * client's) record. It is a real folder — record and index both exist — but its
 * ownership is unknowable. */
function seedOwnerlessFolder(slug: string, displayName: string, isPrivate = false): void {
  const stamp = new Date(0).toISOString();
  store.seed(
    `folder-${slug}`,
    JSON.stringify({
      v: 1,
      slug,
      displayName,
      private: isPrivate,
      createdAt: stamp,
      updatedAt: stamp,
    }),
  );
  store.seed(`folder-${slug}-index`, JSON.stringify({ v: 1, slug, nextSeq: 1, images: [] }));
}

beforeEach(async () => {
  store = new FakeServerStore({ keyId: 'key-1', label: 'Alice The Key' });
  store.install();
  await Promise.all([
    db.settings.clear(),
    db.images.clear(),
    db.runs.clear(),
    db.conversations.clear(),
    db.storeObjects.clear(),
    db.storeThumbs.clear(),
  ]);
});

it("the owner's exact case: his OWN folder reports as yours although his key's label slugifies elsewhere", async () => {
  // First run: the app proposes the label's slug and STORES it as its default.
  await seedSettings('');
  await createFolder(target(), { slug: 'test', displayName: 'test', private: false, who: WHO }, []);
  await createFolder(
    target(),
    { slug: 'bob-public', displayName: 'Bob public', private: false, who: OTHER },
    ['test'],
  );
  await seedImage('test', 1);
  await seedImage('bob-public', 2);

  const { container } = render(<StoreArea />);

  // THE FOLDER THE DIALOG OPENS ON is the IDENTITY's folder (`test`), not the
  // label-derived name: the My-folder scope really holds his one image. With
  // the slug comparison this read "Showing 0 of 0".
  expect(await screen.findByText(/Showing 1 of 1 stored images/)).toBeInTheDocument();
  expect(PROPOSED).not.toBe('test');

  const text = must(container.textContent, 'the rendered text');
  // The destination line names it as HIS.
  expect(text).toContain('Library push destination:');
  expect(text).toContain('test');
  expect(text).toContain('test — yours');
  // THE MISLEADING-PRIVACY MESSAGE IS GONE, and the honest one is not invented.
  expect(screen.queryByText(/belongs to another key/)).not.toBeInTheDocument();
  expect(screen.queryByText(/names no owner/)).not.toBeInTheDocument();
  // The app does NOT present the label-derived name as if it were his folder.
  expect(text).not.toContain(PROPOSED);
});

it("a folder owned by a DIFFERENT id is still not-mine and still warns", async () => {
  await seedSettings(PROPOSED);
  await createFolder(target(), { slug: 'test', displayName: 'test', private: false, who: WHO }, []);
  await createFolder(
    target(),
    { slug: 'bob-public', displayName: 'Bob public', private: false, who: OTHER },
    ['test'],
  );
  const user = userEvent.setup();
  render(<StoreArea />);

  // Mine first: no warning while HIS folder is the destination.
  expect(await screen.findByText(/Showing 0 of 0 stored images/)).toBeInTheDocument();
  expect(screen.queryByText(/belongs to another key/)).not.toBeInTheDocument();

  // Open the OTHER key's folder: the destination moves and the honest warning
  // (kept, not deleted) names the consequence.
  const nav = await screen.findByRole('navigation', { name: 'Store folders' });
  await user.click(within(nav).getByRole('button', { name: /Bob public/ }));

  expect(await screen.findByText(/belongs to another key/)).toBeInTheDocument();
  expect(screen.getByText(/its owner will see your images/)).toBeInTheDocument();
  expect(screen.getByText(/ANOTHER key/)).toBeInTheDocument();
  // And `test` is listed as HIS folder all along.
  expect(within(nav).getByText('test')).toBeInTheDocument();
});

it('a folder record with NO owner is "cannot tell" — never another key\'s, never yours', async () => {
  await seedSettings(PROPOSED);
  seedOwnerlessFolder('ghost', 'Ghost');
  const user = userEvent.setup();
  render(<StoreArea />);

  const nav = await screen.findByRole('navigation', { name: 'Store folders' });
  // The record is READ (not dropped as unreadable): it is a folder the app shows.
  const ghost = within(nav).getByRole('button', { name: /Ghost/ });
  expect(within(nav).getByText(/no owner is recorded in its folder record/)).toBeInTheDocument();
  // Opening it must not pick a side.
  await user.click(ghost);

  expect(await screen.findByText(/names no owner, so the app cannot tell whether this folder is yours/)).toBeInTheDocument();
  expect(screen.queryByText(/belongs to another key/)).not.toBeInTheDocument();
  expect(screen.queryByText(/— yours/)).not.toBeInTheDocument();
  expect(screen.getByText(/its record names no owner/)).toBeInTheDocument();
  // The device upload still has a destination (the app's proposed name), so this
  // is a statement about ownership, not a dead control.
  expect(screen.getByText(/Library push destination/)).toBeInTheDocument();
});

it('the folder list and the dialog default follow the identity for mine / another / unknown', async () => {
  await seedSettings(PROPOSED);
  // MINE, flagged PRIVATE: still visible to me (the flag hides it from others).
  await createFolder(target(), { slug: 'test', displayName: 'Mine private', private: true, who: WHO }, []);
  await createFolder(
    target(),
    { slug: 'their-secret', displayName: 'Their secret', private: true, who: OTHER },
    ['test'],
  );
  await createFolder(
    target(),
    { slug: 'their-public', displayName: 'Their public', private: false, who: OTHER },
    ['test', 'their-secret'],
  );
  seedOwnerlessFolder('ghost', 'Ghost');
  seedOwnerlessFolder('ghost-secret', 'Ghost secret', true);
  render(<StoreArea />);

  const nav = await screen.findByRole('navigation', { name: 'Store folders' });
  // The list: mine (even private), another's public, the unowned public one.
  expect(within(nav).getByRole('button', { name: /Mine private/ })).toBeInTheDocument();
  expect(within(nav).getByRole('button', { name: /Their public/ })).toBeInTheDocument();
  expect(within(nav).getByRole('button', { name: /Ghost/ })).toBeInTheDocument();
  // Hidden: another key's PRIVATE folder, and an unowned PRIVATE one (not mine,
  // so the honour-based flag applies to it like anyone else's).
  expect(within(nav).queryByText('Their secret')).not.toBeInTheDocument();
  expect(within(nav).queryByText('Ghost secret')).not.toBeInTheDocument();

  // The dialog opens on MINE and defaults the destination to it.
  expect((await screen.findAllByText(/Your folder: test/)).length).toBeGreaterThan(0);
  expect(screen.getByText(/Mine private — yours/)).toBeInTheDocument();
  expect(screen.queryByText(/belongs to another key/)).not.toBeInTheDocument();
});

it("with no folder of its own, the app proposes a name and never defaults to another key's folder", async () => {
  await seedSettings(PROPOSED);
  await createFolder(
    target(),
    { slug: 'their-public', displayName: 'Their public', private: false, who: OTHER },
    [],
  );
  const { container } = render(<StoreArea />);

  await screen.findByRole('navigation', { name: 'Store folders' });
  const text = must(container.textContent, 'the rendered text');
  // The proposed NAME is stated as a proposal, not as a fact about a folder.
  expect(text).toContain(PROPOSED);
  expect(text).toContain('No folder record in the store names key key-1 as its owner yet');
  // No destination: the app must not silently aim a push at another key's folder.
  expect(text).toContain('Library push destination: —');
  expect(screen.queryByText(/belongs to another key/)).not.toBeInTheDocument();
});
