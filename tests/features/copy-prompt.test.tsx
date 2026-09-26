import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { Gallery } from '@/features/gallery/Gallery';

/**
 * docs/17 row 22: the prompt-copy control. The owner's ask — one click puts the
 * prompt he is looking at on his clipboard — is only kept if the EXACT stored
 * prompt is what lands there, the tile's copy control does not open the lightbox
 * it sits on, and a copy that did not happen is never reported as one.
 */

const PROMPT = 'a red fox on a mossy log, morning mist, 85mm — full text, not the clamped caption';
const SEED_ID = 'copy-seed-1';

/**
 * `Gallery` plus the app's ONE notice surface. `App` mounts `Toaster`; the
 * failure arms assert the notice as RENDERED text rather than as a mock call,
 * so "the owner can see it" is what is actually checked.
 */
function renderGallery(): void {
  render(
    <>
      <Gallery />
      <Toaster />
    </>,
  );
}

async function seedImage(): Promise<void> {
  await db.images.put({
    id: SEED_ID,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 64,
    height: 32,
    prompt: PROMPT,
    model: 'openai/gpt-image-1',
    source: 'generated',
    createdAt: 1,
    runId: '',
    favorite: false,
    tags: [],
  });
}

/**
 * The clipboard double: the REAL method name and the REAL promise shape (a
 * jsdom stand-in must mirror the API it stands for — ledger rows 14/15). jsdom
 * implements no Clipboard API at all, so every case here is defined explicitly.
 */
function stubClipboard(writeText: (text: string) => Promise<void>): string[] {
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text);
        return writeText(text);
      },
    },
  });
  return copied;
}

beforeEach(async () => {
  await Promise.all([db.images.clear(), db.runs.clear()]);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  await seedImage();
});

afterEach(() => {
  // Leave the navigator exactly as jsdom ships it (no own `clipboard`).
  Reflect.deleteProperty(navigator, 'clipboard');
});

/** Thumbnail → the full image view. */
async function openLightbox(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: `Open image: ${PROMPT}` }));
  return screen.getByRole('dialog', { name: 'Image details' });
}

it('the lightbox copies the EXACT prompt — untruncated — and says so on the button', async () => {
  const user = userEvent.setup();
  const copied = stubClipboard(() => Promise.resolve());
  renderGallery();
  const dialog = await openLightbox(user);

  const button = within(dialog).getByRole('button', { name: 'Copy prompt' });
  await user.click(button);

  expect(copied).toEqual([PROMPT]);
  // The owner's confirmation is the control's own label, and no error toast
  // fired.
  expect(within(dialog).getByRole('button', { name: 'Copied to the clipboard' })).toBeVisible();
  expect(screen.queryByText('Could not copy to the clipboard')).toBeNull();
});

it('the tile copies the STORED prompt (not the clamped caption) and does not open the lightbox', async () => {
  const user = userEvent.setup();
  const copied = stubClipboard(() => Promise.resolve());
  renderGallery();
  const open = await screen.findByRole('button', { name: `Open image: ${PROMPT}` });
  // The caption is clamped to two lines; the copy control is its SIBLING, so the
  // click cannot bubble into the open action.
  const tileCopy = screen.getByRole('button', { name: `Copy prompt: ${PROMPT}` });
  expect(open.contains(tileCopy)).toBe(false);

  await user.click(tileCopy);

  expect(copied).toEqual([PROMPT]);
  expect(screen.queryByRole('dialog', { name: 'Image details' })).toBeNull();
});

it('a rejected write is a visible error and never a claimed copy', async () => {
  const user = userEvent.setup();
  stubClipboard(() => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')));
  renderGallery();
  const dialog = await openLightbox(user);

  await user.click(within(dialog).getByRole('button', { name: 'Copy prompt' }));

  // Rule 2: the real reason reaches the one notice surface. (The matcher is
  // loose on purpose: a `DOMException` stringifies differently across engines,
  // and `errorMessage` is the seam that normalises it.)
  expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument();
  expect(screen.getByText(/Write permission denied\./)).toBeInTheDocument();
  // ... and rule 1: the control does NOT claim the copy happened.
  const button = within(dialog).getByRole('button', { name: 'Copy prompt' });
  expect(button).toHaveTextContent('Copy');
  expect(button).not.toHaveTextContent('Copied');
});

it('a missing clipboard API is a loud error, never a silent no-op', async () => {
  const user = userEvent.setup();
  // The insecure-context / old-browser case the seam refuses to paper over.
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  renderGallery();
  const dialog = await openLightbox(user);

  await user.click(within(dialog).getByRole('button', { name: 'Copy prompt' }));

  expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument();
  expect(screen.getByText(/clipboard API is unavailable/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
});
