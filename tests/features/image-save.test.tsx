import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { Gallery } from '@/features/gallery/Gallery';

/**
 * docs/17 row 25, part 3 — "every image needs a save option in detail view
 * (using file selector where supported)".
 *
 * The lightbox's ONE save control goes through the ONE save seam, so the picker
 * / anchor branch, the cancel-is-silent rule and the error surface are the
 * seam's decisions, not the lightbox's. What is pinned HERE is that the owner
 * gets a REAL "Save as…" with a suggested name derived safely from the prompt,
 * and that the bytes handed over are the stored bytes.
 */

/** Slashes, a newline, an emoji and more than a file name's worth of text. */
const HOSTILE_PROMPT = `../..\\etc/pa\nsswd 🌃 ${'long '.repeat(40)}END`;
const STORED_BYTES = new Uint8Array([11, 22, 33, 44, 55]);

interface PickerOptions {
  suggestedName: string;
  types?: { accept: Record<string, string[]> }[];
}

function installPicker(): { options: PickerOptions[]; blobs: Blob[] } {
  const captured = { options: [] as PickerOptions[], blobs: [] as Blob[] };
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (data: Blob) => {
          captured.blobs.push(data);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
  };
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: (options: PickerOptions) => {
      captured.options.push(options);
      return Promise.resolve(handle as unknown as FileSystemFileHandle);
    },
  });
  return captured;
}

beforeEach(async () => {
  await Promise.all([db.images.clear(), db.runs.clear()]);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  await db.images.put({
    id: 'save-seed',
    bytes: STORED_BYTES,
    mimeType: 'image/jpeg',
    width: 64,
    height: 32,
    prompt: HOSTILE_PROMPT,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 1,
    runId: '',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

async function openLightbox(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    <>
      <Gallery version={0} />
      <Toaster />
    </>,
  );
  await user.click(await screen.findByRole('button', { name: `Open image: ${HOSTILE_PROMPT}` }));
  return screen.getByRole('dialog', { name: 'Image details' });
}

it('the lightbox offers a real "Save as…" with a sanitized, extension-correct suggested name', async () => {
  const user = userEvent.setup();
  const captured = installPicker();
  const dialog = await openLightbox(user);

  await user.click(within(dialog).getByRole('button', { name: /Save as/ }));
  await waitFor(() => {
    expect(captured.blobs).toHaveLength(1);
  });

  const suggested = captured.options[0]?.suggestedName ?? '';
  // The right extension for the MIME type, and nothing a path can act on.
  expect(suggested).toMatch(/\.jpg$/);
  expect(suggested).not.toContain('/');
  expect(suggested).not.toContain('\\');
  expect(suggested).not.toContain('..');
  expect(suggested).not.toContain('\n');
  expect(suggested).not.toMatch(/[^A-Za-z0-9.-]/);
  expect(suggested.length).toBeLessThanOrEqual(80);
  // Readable: the prompt's head survives, and the id stub makes it unique.
  expect(suggested.startsWith('etc-pa-sswd-long')).toBe(true);
  expect(suggested).toContain('save-seed'.slice(0, 8));
  expect(captured.options[0]?.types).toEqual([{ accept: { 'image/jpeg': ['.jpg'] } }]);

  // The bytes are the STORED bytes — not a re-encode of the on-screen image.
  const written = new Uint8Array(await (captured.blobs[0] ?? new Blob()).arrayBuffer());
  expect(Array.from(written)).toEqual(Array.from(STORED_BYTES));
  expect(await screen.findByText(`Saved ${suggested}`)).toBeInTheDocument();
});

it('where there is no picker the lightbox still saves, through the anchor fallback', async () => {
  const user = userEvent.setup();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const dialog = await openLightbox(user);

  await user.click(within(dialog).getByRole('button', { name: /Save as/ }));
  await waitFor(() => {
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
  const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
  expect(anchor?.download).toMatch(/\.jpg$/);
  expect(anchor?.getAttribute('href')).toBe('blob:x');
  expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
});

it('a cancelled picker in the lightbox stays silent; a failure is visible', async () => {
  const user = userEvent.setup();
  const dialog = await openLightbox(user);
  const button = within(dialog).getByRole('button', { name: /Save as/ });

  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(new DOMException('aborted', 'AbortError')),
  });
  await user.click(button);
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  expect(screen.queryByText(/^Saved /)).toBeNull();
  expect(screen.queryByText(/Could not save/)).toBeNull();

  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(new DOMException('Permission denied.', 'NotAllowedError')),
  });
  await user.click(button);
  expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
  expect(screen.getByText(/Permission denied\./)).toBeInTheDocument();
});
