import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { Gallery } from '@/features/gallery/Gallery';

/**
 * docs/17 row 32 — the favourite CONTROL. The owner's ask is one boolean and an
 * ordering, so what these pins defend is that the tile and the lightbox are the
 * SAME control on the SAME row (they must never disagree), that the tile's star
 * does not open the lightbox it sits on, and that a favourite actually floats to
 * the top of the grid through the repo's ONE ordering.
 *
 * The grid order here is read from the DOM, so it is the RENDERED order the
 * owner sees — the repo's ordering pin (`tests/db/imageRepo.test.ts`) states the
 * rule, this states that the gallery shows it.
 */

const OLDEST = 'the oldest picture';
const MIDDLE = 'the middle picture';
const NEWEST = 'the newest picture';

/** `Gallery` plus the app's ONE notice surface (as `App` mounts it). */
function renderGallery(): void {
  render(
    <>
      <Gallery />
      <Toaster />
    </>,
  );
}

async function seed(prompt: string, id: string, createdAt: number): Promise<void> {
  await db.images.put({
    id,
    bytes: new Uint8Array([createdAt, createdAt + 1]),
    mimeType: 'image/png',
    width: 64,
    height: 32,
    prompt,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt,
    runId: '',
    favorite: false,
    tags: [],
  });
}

beforeEach(async () => {
  await Promise.all([db.images.clear(), db.runs.clear()]);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The tile that holds this prompt's open control. */
function tileFor(prompt: string): HTMLElement {
  const tile = screen.getByRole('button', { name: `Open image: ${prompt}` }).parentElement;
  if (tile === null) throw new Error(`no tile for ${prompt}`);
  return tile;
}

function starIn(scope: HTMLElement): HTMLElement {
  return within(scope).getByRole('button', { name: 'Favourite' });
}

/** The tile prompts in the order the grid renders them. */
function gridOrder(): string[] {
  return screen
    .getAllByRole('button', { name: /^Open image: / })
    .map((button) => (button.getAttribute('aria-label') ?? '').replace('Open image: ', ''));
}

it('the tile star is a SIBLING of the open control and never opens the lightbox', async () => {
  await seed(OLDEST, 'fav-oldest', 1);
  const user = userEvent.setup();
  renderGallery();

  const open = await screen.findByRole('button', { name: `Open image: ${OLDEST}` });
  const star = starIn(tileFor(OLDEST));
  expect(open.contains(star)).toBe(false);

  await user.click(star);

  // No dialog: the tile's control acted on the image, not on the tile.
  expect(screen.queryByRole('dialog', { name: 'Image details' })).toBeNull();
  // ... and the flag is STORED, not merely drawn.
  await waitFor(async () => {
    await expect(db.images.get('fav-oldest')).resolves.toMatchObject({ favorite: true });
  });
});

it('favouriting the OLDEST image floats it above the newer ones', async () => {
  await seed(OLDEST, 'fav-oldest', 1);
  await seed(MIDDLE, 'fav-middle', 2);
  await seed(NEWEST, 'fav-newest', 3);
  const user = userEvent.setup();
  renderGallery();

  await screen.findByRole('button', { name: `Open image: ${NEWEST}` });
  expect(gridOrder()).toEqual([NEWEST, MIDDLE, OLDEST]);

  await user.click(starIn(tileFor(OLDEST)));

  // Favourites first, newest-first within each group — the oldest favourite is
  // now first, and the two non-favourites keep their own newest-first order.
  await waitFor(() => {
    expect(gridOrder()).toEqual([OLDEST, NEWEST, MIDDLE]);
  });
  expect(starIn(tileFor(OLDEST))).toHaveAttribute('aria-pressed', 'true');
  expect(starIn(tileFor(NEWEST))).toHaveAttribute('aria-pressed', 'false');
});

it('the lightbox star and the tile star agree on the SAME row', async () => {
  await seed(OLDEST, 'fav-oldest', 1);
  await seed(NEWEST, 'fav-newest', 3);
  const user = userEvent.setup();
  renderGallery();

  // Favourite from the LIGHTBOX ...
  await user.click(await screen.findByRole('button', { name: `Open image: ${OLDEST}` }));
  const dialog = screen.getByRole('dialog', { name: 'Image details' });
  const dialogStar = starIn(dialog);
  expect(dialogStar).toHaveAttribute('aria-pressed', 'false');
  await user.click(dialogStar);

  await waitFor(() => {
    expect(starIn(screen.getByRole('dialog', { name: 'Image details' }))).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  // ... and the tile behind it shows the same state: one row, one control.
  expect(starIn(tileFor(OLDEST))).toHaveAttribute('aria-pressed', 'true');
  await waitFor(async () => {
    await expect(db.images.get('fav-oldest')).resolves.toMatchObject({ favorite: true });
  });

  // Turning it back OFF in the lightbox turns the tile's star off too.
  await user.click(starIn(screen.getByRole('dialog', { name: 'Image details' })));
  await waitFor(() => {
    expect(starIn(tileFor(OLDEST))).toHaveAttribute('aria-pressed', 'false');
  });
});

it('a failed write is a visible error and never a claimed favourite', async () => {
  await seed(OLDEST, 'fav-oldest', 1);
  const user = userEvent.setup();
  renderGallery();

  await screen.findByRole('button', { name: `Open image: ${OLDEST}` });
  const star = starIn(tileFor(OLDEST));
  // The row is gone (deleted in another tab): the repo refuses to update a
  // missing row rather than silently doing nothing (rule 1).
  await db.images.delete('fav-oldest');
  await user.click(star);

  expect(await screen.findByText('Could not update the favourite')).toBeInTheDocument();
  // Rule 1: the star still says OFF, because nothing was stored.
  expect(starIn(tileFor(OLDEST))).toHaveAttribute('aria-pressed', 'false');
  expect(starIn(tileFor(OLDEST))).toHaveTextContent('☆');
});
