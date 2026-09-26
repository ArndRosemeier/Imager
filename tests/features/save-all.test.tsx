import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { unzipSync, strFromU8 } from 'fflate';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { ExportPanel } from '@/features/export/ExportPanel';
import { MANIFEST_ENTRY } from '@/features/export/exportLibrary';

/**
 * docs/17 row 25 — "Save all", the owner's way out of the browser.
 *
 * The pins that matter here: the two actions say what they contain (and that
 * the key is NOT in either), the size is shown before saving, and both really
 * produce the archive — checked by unzipping the bytes the app handed to the
 * picker, not by trusting a mocked builder.
 */

const KEY_SENTINEL = 'sk-or-v1-SENTINEL-9f3c-DO-NOT-EXPORT';
const HOSTILE_PROMPT = 'a red fox / ../../etc 🌃';

interface PickerOptions {
  suggestedName: string;
  types?: { accept: Record<string, string[]> }[];
}

interface Captured {
  options: PickerOptions[];
  blobs: Blob[];
}

function installPicker(): Captured {
  const captured: Captured = { options: [], blobs: [] };
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

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

async function seed(): Promise<void> {
  await db.images.bulkPut([
    {
      id: 'seed-png',
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/png',
      width: 8,
      height: 4,
      prompt: HOSTILE_PROMPT,
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
      createdAt: 200,
      runId: 'run-1',
      favorite: false,
      tags: [],
    },
    {
      id: 'seed-jpeg',
      bytes: new Uint8Array([9, 9, 9]),
      mimeType: 'image/jpeg',
      width: 4,
      height: 4,
      prompt: 'a second picture',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
      createdAt: 100,
      runId: 'run-1',
      favorite: false,
      tags: [],
    },
  ]);
  await db.runs.put({
    id: 'run-1',
    kind: 'generate',
    prompt: HOSTILE_PROMPT,
    model: 'google/gemini-2.5-flash-image',
    inputImageIds: [],
    requestedCount: 2,
    receivedCount: 2,
    filteredCount: 0,
    costUsd: 0.01,
    createdAt: 100,
    error: null,
  });
  await db.settings.put({
    id: 'settings',
    openRouterApiKey: KEY_SENTINEL,
    imageModel: 'google/gemini-2.5-flash-image',
    refineChatModel: 'openai/gpt-5-image',
  });
}

beforeEach(async () => {
  await Promise.all([db.images.clear(), db.runs.clear(), db.conversations.clear(), db.settings.clear()]);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

function renderPanel(): void {
  render(
    <>
      <ExportPanel />
      <Toaster />
    </>,
  );
}

it('names both modes, one line each, states the key omission before saving, and shows the size', async () => {
  await seed();
  renderPanel();

  expect(await screen.findByText('All images — one ZIP')).toBeInTheDocument();
  expect(screen.getByText(/no settings, no chats/i)).toBeInTheDocument();
  expect(screen.getByText('Everything — backup ZIP (Imager format)')).toBeInTheDocument();
  // The key's absence is stated on screen, before any click.
  expect(screen.getByText(/OpenRouter API key is deliberately NOT included/i)).toBeInTheDocument();
  // The approximate size is shown (3 bytes + 4 bytes ≈ 7 B, honestly labelled).
  expect(screen.getByText(/2 images · ≈ 7 B of image data/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save images ZIP' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Save backup ZIP' })).toBeEnabled();
});

it('with an empty gallery the images action is refused with the reason, not an empty file', async () => {
  renderPanel();
  expect(await screen.findByText(/Nothing to save yet — the gallery is empty\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save images ZIP' })).toBeDisabled();
  // A backup can still carry settings and chats.
  expect(screen.getByRole('button', { name: 'Save backup ZIP' })).toBeEnabled();
});

it('mode A really saves a ZIP of the pictures, named for the moment it was made', async () => {
  await seed();
  const captured = installPicker();
  renderPanel();
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Save images ZIP' }));
  await waitFor(() => {
    expect(captured.blobs).toHaveLength(1);
  });

  const name = captured.options[0]?.suggestedName ?? '';
  expect(name).toMatch(/^imager-images-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/);
  expect(captured.options[0]?.types).toEqual([{ accept: { 'application/zip': ['.zip'] } }]);
  const entries = unzipSync(
    new Uint8Array(await (captured.blobs[0] ?? new Blob()).arrayBuffer()),
  );
  expect(Object.keys(entries)).toHaveLength(2);
  expect(Object.keys(entries)).not.toContain(MANIFEST_ENTRY);
  // The hostile prompt became a safe entry name, and no name carries a path.
  for (const key of Object.keys(entries)) {
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
    expect(key).toMatch(/\.(png|jpg)$/);
  }
  // The visible confirmation names the file.
  expect(await screen.findByText(`Saved ${name}`)).toBeInTheDocument();
});

it('mode B really saves the internal format, with no key anywhere in the bytes', async () => {
  await seed();
  const captured = installPicker();
  renderPanel();
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Save backup ZIP' }));
  await waitFor(() => {
    expect(captured.blobs).toHaveLength(1);
  });

  expect(captured.options[0]?.suggestedName).toMatch(/^imager-backup-.*\.zip$/);
  const archive = new Uint8Array(await (captured.blobs[0] ?? new Blob()).arrayBuffer());
  const entries = unzipSync(archive);
  expect(Object.keys(entries).sort()).toEqual(
    [MANIFEST_ENTRY, 'images/seed-jpeg.jpg', 'images/seed-png.png'].sort(),
  );
  const manifestText = strFromU8(entries[MANIFEST_ENTRY] ?? new Uint8Array());
  expect(manifestText).not.toContain(KEY_SENTINEL);
  expect(manifestText).toContain('"version": 1');
  // The settings (minus the key) are in there; the archive bytes are clean.
  expect(manifestText).toContain('openai/gpt-5-image');
  expect(strFromU8(archive, true)).not.toContain(KEY_SENTINEL);
});

it('a cancelled picker says nothing at all; a real failure is a visible error', async () => {
  await seed();
  const user = userEvent.setup();
  renderPanel();
  const images = await screen.findByRole('button', { name: 'Save images ZIP' });

  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  await user.click(images);
  await waitFor(() => {
    expect(images).toBeEnabled();
  });
  expect(screen.queryByText(/^Saved /)).toBeNull();
  expect(screen.queryByText(/Could not save/)).toBeNull();

  installRejectingPicker(new DOMException('Disk is full.', 'NotAllowedError'));
  await user.click(images);
  expect(await screen.findByText(/Could not save imager-images-/)).toBeInTheDocument();
  expect(screen.getByText(/Disk is full\./)).toBeInTheDocument();
});
