import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { Gallery } from '@/features/gallery/Gallery';

/**
 * docs/17 row 65: the Gallery imports images from files and from the clipboard,
 * through the one upload path (`saveImageFile`), so the same picture is never
 * stored twice.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);

beforeEach(async () => {
  await db.images.clear();
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 64, height: 36, close: () => undefined }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const png = (name: string, bytes = PNG): File =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' });

function paste(files: File[], target: Element = document.body): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files } });
  target.dispatchEvent(event);
}

it('the Import button takes several files and stores each once', async () => {
  render(
    <>
      <Gallery />
      <Toaster />
    </>,
  );
  const user = userEvent.setup();
  expect(await screen.findByText('No images yet.')).toBeInTheDocument();

  await user.upload(screen.getByLabelText('Import images from files'), [
    png('a.png'),
    png('b.png', new Uint8Array([...PNG, 1])),
  ]);
  await waitFor(async () => {
    expect(await db.images.count()).toBe(2);
  });
  expect(await screen.findByText('Showing 2 of 2 images')).toBeInTheDocument();

  // The same file again is the same gallery image.
  await user.upload(screen.getByLabelText('Import images from files'), png('a-again.png'));
  await screen.findByText('1 already in the gallery');
  expect(await db.images.count()).toBe(2);
});

it('a pasted image lands in the gallery, and pasting it again adds nothing', async () => {
  render(
    <>
      <Gallery />
      <Toaster />
    </>,
  );
  await screen.findByText('No images yet.');

  paste([png('image.png')]);
  expect(await screen.findByText('Showing 1 of 1 images')).toBeInTheDocument();
  const [stored] = await db.images.toArray();
  expect(stored?.prompt).toMatch(/^Pasted image \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.png$/);
  expect(stored?.source).toBe('uploaded');

  paste([png('image.png')]);
  await screen.findByText('1 already in the gallery');
  expect(await db.images.count()).toBe(1);
});

it('a paste of text, or into a text field, is left alone', async () => {
  render(
    <>
      <Gallery />
      <Toaster />
      <input aria-label="elsewhere" />
    </>,
  );
  await screen.findByText('No images yet.');
  paste([new File(['hello'], 'note.txt', { type: 'text/plain' })]);
  paste([png('image.png')], screen.getByLabelText('elsewhere'));
  fireEvent.paste(document.body);
  await new Promise((r) => setTimeout(r, 50));
  expect(await db.images.count()).toBe(0);
});
