import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { Gallery } from '@/features/gallery/Gallery';
import { GALLERY_SIZE_STORAGE_KEY } from '@/features/gallery/gallerySize';

/**
 * docs/17 row 34 — the tag bar, the tag editor and the image-size control, as
 * the owner drives them. What these pins defend:
 *
 *  * the bar lists EVERY tag in use with the count of images carrying it, and it
 *    is derived from the rows (a tag nobody carries is absent);
 *  * the AND/OR toggle produces two DIFFERENT result sets from the SAME
 *    selection, the selection is visibly active, and filtering keeps the repo's
 *    favourite-first/newest-first order (it never becomes a second ordering);
 *  * the filter cannot hide images SILENTLY: "Showing X of Y" is always there,
 *    and a no-match selection is the honest empty state, not a blank grid;
 *  * free typing stores the normalized form, existing tags are offered as
 *    suggestions, and the owner's near-duplicate worry ("Orc"/"orc") cannot
 *    produce two chips;
 *  * the size preference survives a remount and changes the rendered grid class.
 *
 * jsdom computes no layout, so the class/track claim is asserted at the CLASS
 * level here; the real column widths are MEASURED in a browser (the ledger row's
 * evidence).
 */

const FAV_BOTH = 'the favourite carries orc and forest';
const ONLY_ORC = 'the orc-only picture';
const ONLY_FOREST = 'the forest-only picture';
const ONLY_CITY = 'the city-only picture';

async function seedImage(row: {
  id: string;
  prompt: string;
  createdAt: number;
  favorite?: boolean;
  tags?: string[];
}): Promise<void> {
  await db.images.put({
    id: row.id,
    bytes: new Uint8Array([row.createdAt, row.createdAt + 1]),
    mimeType: 'image/png',
    width: 64,
    height: 32,
    prompt: row.prompt,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: row.createdAt,
    runId: '',
    favorite: row.favorite ?? false,
    tags: row.tags ?? [],
  });
}

beforeEach(async () => {
  await Promise.all([db.images.clear(), db.runs.clear()]);
  try {
    localStorage.removeItem(GALLERY_SIZE_STORAGE_KEY);
  } catch {
    // No localStorage in this environment; nothing to reset.
  }
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderGallery(): ReturnType<typeof render> {
  return render(
    <>
      <Gallery />
      <Toaster />
    </>,
  );
}

/** The tile prompts in the order the grid renders them. */
function gridOrder(): string[] {
  return screen
    .getAllByRole('button', { name: /^Open image: / })
    .map((button) => (button.getAttribute('aria-label') ?? '').replace('Open image: ', ''));
}

function grid(): Element {
  const gallery = screen.getByRole('region', { name: 'Gallery' });
  const element = gallery.querySelector('.grid');
  if (element === null) throw new Error('the gallery grid is not rendered');
  return element;
}

const tagChip = (label: string): HTMLElement => screen.getByRole('button', { name: label });

function matchTab(name: 'AND' | 'OR'): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Tag match' })).getByRole('tab', { name });
}

async function openLightbox(prompt: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Open image: ${prompt}` }));
  return screen.getByRole('dialog', { name: 'Image details' });
}

/* ------------------------------------------------------------ the tag bar */

it('the bar lists every tag with its count and filters the grid (AND vs OR)', async () => {
  await seedImage({
    id: 'a',
    prompt: FAV_BOTH,
    createdAt: 1,
    favorite: true,
    tags: ['orc', 'forest'],
  });
  await seedImage({ id: 'b', prompt: ONLY_ORC, createdAt: 2, tags: ['orc'] });
  await seedImage({ id: 'c', prompt: ONLY_FOREST, createdAt: 3, tags: ['forest'] });
  await seedImage({ id: 'd', prompt: ONLY_CITY, createdAt: 4, tags: ['city'] });
  const user = userEvent.setup();
  renderGallery();

  await screen.findByRole('button', { name: `Open image: ${FAV_BOTH}` });
  // The repo's ONE order: favourite first, then newest-first.
  expect(gridOrder()).toEqual([FAV_BOTH, ONLY_CITY, ONLY_FOREST, ONLY_ORC]);
  // EVERY tag in use, with the count of images carrying it.
  expect(tagChip('orc (2 images)')).toBeInTheDocument();
  expect(tagChip('forest (2 images)')).toBeInTheDocument();
  expect(tagChip('city (1 image)')).toBeInTheDocument();
  expect(screen.getByText('Showing 4 of 4 images')).toBeInTheDocument();

  // The SAME selection, matched two ways.
  await user.click(tagChip('orc (2 images)'));
  await user.click(tagChip('forest (2 images)'));
  // The selection is visibly ACTIVE (the role class that paints the accent).
  expect(tagChip('orc (2 images)')).toHaveAttribute('aria-pressed', 'true');
  expect(tagChip('orc (2 images)').className).toContain('tag-chip-on');
  expect(tagChip('city (1 image)')).toHaveAttribute('aria-pressed', 'false');

  // AND (the default) = the intersection: only the image carrying BOTH.
  expect(matchTab('AND')).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => {
    expect(gridOrder()).toEqual([FAV_BOTH]);
  });
  expect(screen.getByText('Showing 1 of 4 images')).toBeInTheDocument();

  // OR = the union: a DIFFERENT set from the same selection, order preserved
  // (the favourite still leads; newest-first inside the non-favourites).
  await user.click(matchTab('OR'));
  await waitFor(() => {
    expect(gridOrder()).toEqual([FAV_BOTH, ONLY_FOREST, ONLY_ORC]);
  });
  expect(screen.getByText('Showing 3 of 4 images')).toBeInTheDocument();
});

it('a selection no image satisfies shows the honest empty state, never a blank grid', async () => {
  await seedImage({ id: 'b', prompt: ONLY_ORC, createdAt: 2, tags: ['orc'] });
  await seedImage({ id: 'd', prompt: ONLY_CITY, createdAt: 4, tags: ['city'] });
  const user = userEvent.setup();
  renderGallery();

  await screen.findByRole('button', { name: `Open image: ${ONLY_ORC}` });
  await user.click(tagChip('orc (1 image)'));
  await user.click(tagChip('city (1 image)'));

  // AND over two tags no single image carries = nothing, and the COUNT SAYS SO.
  expect(await screen.findByText('No images match these tags.')).toBeInTheDocument();
  expect(screen.getByText('Showing 0 of 2 images')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Open image: / })).toBeNull();

  // Clearing the filter brings the library straight back.
  await user.click(screen.getByRole('button', { name: 'Clear tags' }));
  await waitFor(() => {
    expect(gridOrder()).toEqual([ONLY_CITY, ONLY_ORC]);
  });
  expect(screen.getByText('Showing 2 of 2 images')).toBeInTheDocument();
});

it('the empty library keeps its own empty state and offers no filter chrome', async () => {
  renderGallery();
  expect(await screen.findByText('No images yet.')).toBeInTheDocument();
  // Nothing to filter and nothing to size: the tag bar and the size control are
  // absent rather than empty furniture (the empty state is unchanged).
  expect(screen.queryByRole('tablist', { name: 'Tag match' })).toBeNull();
  expect(screen.queryByRole('tablist', { name: 'Image size' })).toBeNull();
});

/* ----------------------------------------------------------- the tag editor */

it('free typing stores the normalized tag and existing tags are offered', async () => {
  await seedImage({ id: 'a', prompt: FAV_BOTH, createdAt: 1, tags: ['orc', 'forest'] });
  await seedImage({ id: 'b', prompt: ONLY_CITY, createdAt: 2, tags: [] });
  const user = userEvent.setup();
  renderGallery();

  const dialog = await openLightbox(ONLY_CITY);
  // The existing tags are OFFERED (derived from the other images) before typing.
  expect(within(dialog).getByRole('button', { name: 'Add tag orc' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Add tag forest' })).toBeInTheDocument();

  // Typing narrows the suggestions.
  await user.type(within(dialog).getByLabelText('New tag'), 'for');
  expect(within(dialog).queryByRole('button', { name: 'Add tag orc' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Add tag forest' })).toBeInTheDocument();

  // Free typing is the primary path: "  Dark   Forest " stores "dark forest".
  await user.clear(within(dialog).getByLabelText('New tag'));
  await user.type(within(dialog).getByLabelText('New tag'), '  Dark   Forest ');
  await user.click(within(dialog).getByRole('button', { name: 'Add tag' }));

  await waitFor(async () => {
    await expect(db.images.get('b')).resolves.toMatchObject({ tags: ['dark forest'] });
  });
  // The chip on screen is the STORED value, not the typed one.
  expect(
    await within(dialog).findByRole('button', { name: 'Remove tag dark forest' }),
  ).toBeInTheDocument();
});

it('the owner\'s near-duplicate: typing "Orc" for a second image is the SAME tag', async () => {
  await seedImage({ id: 'a', prompt: FAV_BOTH, createdAt: 1, tags: ['orc'] });
  await seedImage({ id: 'b', prompt: ONLY_CITY, createdAt: 2, tags: [] });
  const user = userEvent.setup();
  renderGallery();

  const dialog = await openLightbox(ONLY_CITY);
  await user.type(within(dialog).getByLabelText('New tag'), 'Orc');
  await user.click(within(dialog).getByRole('button', { name: 'Add tag' }));

  await waitFor(async () => {
    // Stored as the canonical form, so it is the SAME string the first image has.
    await expect(db.images.get('b')).resolves.toMatchObject({ tags: ['orc'] });
  });

  // ONE chip carries both images; "Orc" never becomes a second one.
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(await screen.findByRole('button', { name: 'orc (2 images)' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Orc/ })).toBeNull();
});

it('a tag whose last image loses it DISAPPEARS from the bar (the list is derived)', async () => {
  await seedImage({ id: 'a', prompt: FAV_BOTH, createdAt: 1, tags: ['orc'] });
  await seedImage({ id: 'd', prompt: ONLY_CITY, createdAt: 2, tags: ['city'] });
  const user = userEvent.setup();
  renderGallery();

  await screen.findByRole('button', { name: 'city (1 image)' });
  const dialog = await openLightbox(ONLY_CITY);
  await user.click(within(dialog).getByRole('button', { name: 'Remove tag city' }));

  await waitFor(async () => {
    await expect(db.images.get('d')).resolves.toMatchObject({ tags: [] });
  });
  // No image carries "city" any more, so the chip is simply gone — nothing had
  // to be deleted from a second store.
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'city (1 image)' })).toBeNull();
  });
  expect(screen.getByRole('button', { name: 'orc (1 image)' })).toBeInTheDocument();
});

/* ---------------------------------------------------------- image size */

it('the size control changes the grid class and survives a remount', async () => {
  await seedImage({ id: 'a', prompt: FAV_BOTH, createdAt: 1, tags: ['orc'] });
  const user = userEvent.setup();
  const first = renderGallery();

  await screen.findByRole('button', { name: `Open image: ${FAV_BOTH}` });
  // Medium IS the grid the gallery always had.
  expect(grid().className).toContain('xl:grid-cols-4');
  const sizeTabs = (): HTMLElement => screen.getByRole('tablist', { name: 'Image size' });
  expect(within(sizeTabs()).getByRole('tab', { name: 'Medium' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await user.click(within(sizeTabs()).getByRole('tab', { name: 'Small' }));
  expect(grid().className).toContain('xl:grid-cols-8');
  expect(grid().className).not.toContain('xl:grid-cols-4');

  await user.click(within(sizeTabs()).getByRole('tab', { name: 'Large' }));
  expect(grid().className).toContain('xl:grid-cols-3');

  // The PREFERENCE is persisted (the seam's own key), so the next mount paints
  // the owner's choice instead of the default.
  expect(localStorage.getItem(GALLERY_SIZE_STORAGE_KEY)).toBe('Large');
  await user.click(within(sizeTabs()).getByRole('tab', { name: 'Small' }));
  first.unmount();

  renderGallery();
  await screen.findByRole('button', { name: `Open image: ${FAV_BOTH}` });
  expect(
    within(screen.getByRole('tablist', { name: 'Image size' })).getByRole('tab', { name: 'Small' }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(grid().className).toContain('xl:grid-cols-8');
});
