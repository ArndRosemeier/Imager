import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { db } from '@/db/db';
import { conversationSchema, type Conversation } from '@/domain/chat';
import { runSchema, type Run, type StoredImage } from '@/domain/image';
import type { Settings } from '@/domain/settings';
import { buildBackupArchive, type ExportSource } from '@/features/export/exportLibrary';
import { ImportPanel } from '@/features/import/ImportPanel';

/**
 * docs/17 row 27 — "Load your work", the owner's way back IN.
 *
 * Pins the FLOW the owner asked for: choose a file → a preview that says what is
 * inside and what each conflict option would do BEFORE anything is written →
 * the two explicit choices → confirm → an honest result. And the two silences:
 * a cancelled picker says nothing and writes nothing, while a real failure is
 * loud and names the problem.
 */

const KEY_SENTINEL = 'sk-or-v1-SENTINEL-9f3c-DO-NOT-EXPORT';

const ARCHIVE_SETTINGS: Settings = {
  openRouterApiKey: KEY_SENTINEL,
  imageModel: 'google/gemini-2.5-flash-image',
  refineChatModel: 'openai/gpt-5-image',
};

const RUN: Run = runSchema.parse({
  id: 'run-1',
  kind: 'generate',
  prompt: 'a red fox',
  model: 'google/gemini-2.5-flash-image',
  inputImageIds: ['panel-a'],
  requestedCount: 1,
  receivedCount: 1,
  filteredCount: 0,
  costUsd: 0.01,
  createdAt: 1_700_000_000_000,
  error: null,
});

const CONVERSATION: Conversation = conversationSchema.parse({
  id: 'conversation-1',
  title: 'a red fox',
  model: 'openai/gpt-5-image',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  messages: [
    {
      id: 'message-1',
      role: 'user',
      text: 'make the sky darker',
      imageIds: ['panel-a'],
      runId: '',
      model: '',
      costUsd: null,
      error: null,
      createdAt: 1_700_000_000_000,
    },
  ],
});

function image(id: string, bytes: number[]): StoredImage {
  return {
    id,
    bytes: new Uint8Array(bytes),
    mimeType: 'image/png',
    width: 8,
    height: 4,
    prompt: 'a red fox',
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 1_700_000_000_000,
    runId: 'run-1',
    favorite: false,
  };
}

const SOURCE: ExportSource = {
  images: [image('panel-a', [1, 2, 3]), image('panel-b', [9, 8, 7])],
  runs: [RUN],
  conversations: [CONVERSATION],
  settings: ARCHIVE_SETTINGS,
};

async function backupFile(): Promise<File> {
  const archive = await buildBackupArchive(SOURCE, new Date('2026-09-26T10:00:00.000Z'));
  return new File([archive.bytes], 'imager-backup-2026-09-26T10-00-00-000Z.zip', {
    type: 'application/zip',
  });
}

function installPicker(file: File): { options: unknown[] } {
  const options: unknown[] = [];
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: (received: unknown) => {
      options.push(received);
      return Promise.resolve([
        { getFile: () => Promise.resolve(file) } as unknown as FileSystemFileHandle,
      ]);
    },
  });
  return { options };
}

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

beforeEach(async () => {
  Reflect.deleteProperty(window, 'showOpenFilePicker');
  await Promise.all([
    db.images.clear(),
    db.runs.clear(),
    db.conversations.clear(),
    db.settings.clear(),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});

function renderPanel(): void {
  render(
    <>
      <ImportPanel />
      <Toaster />
    </>,
  );
}

async function chooseFile(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Choose backup file…' }));
}

it('imports a backup through the UI: preview, choices, confirm, result and toast', async () => {
  await db.settings.put({
    id: 'settings',
    openRouterApiKey: KEY_SENTINEL,
    imageModel: 'live/model-before',
    refineChatModel: 'live/refine',
  });
  installPicker(await backupFile());
  renderPanel();
  const user = userEvent.setup();

  await chooseFile(user);

  // The preview says what is in the file and how it meets the library.
  expect(await screen.findByText('imager-backup-2026-09-26T10-00-00-000Z.zip')).toBeInTheDocument();
  expect(
    screen.getByText('Images: 2 in the file — 2 new, 0 already here'),
  ).toBeInTheDocument();
  expect(screen.getByText('Runs: 1 in the file — 1 new, 0 already here')).toBeInTheDocument();
  expect(
    screen.getByText('Conversations: 1 in the file — 1 new, 0 already here'),
  ).toBeInTheDocument();
  // Nothing has been written yet.
  expect(await db.images.count()).toBe(0);

  // The owner's settings choice defaults to Apply; the conflict choice defaults
  // to Keep both, and BOTH are explicit controls on screen.
  expect(screen.getByRole('tab', { name: 'Keep both' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('button', { name: 'Import now' }));

  const result = await screen.findByLabelText('Import result');
  expect(within(result).getByText('Imported')).toBeInTheDocument();
  expect(
    within(result).getByText(
      'images: 2 added, 0 replaced, 0 skipped · runs: 1 added, 0 replaced, 0 skipped · conversations: 1 added, 0 replaced, 0 skipped · settings applied',
    ),
  ).toBeInTheDocument();
  // The same summary reaches the toast (the notice and the screen cannot drift).
  expect(await screen.findByText('Backup loaded')).toBeInTheDocument();

  expect(await db.images.count()).toBe(2);
  expect(await db.runs.count()).toBe(1);
  expect(await db.conversations.count()).toBe(1);
  const settingsRow = await db.settings.get('settings');
  expect(settingsRow?.imageModel).toBe(ARCHIVE_SETTINGS.imageModel);
  expect(settingsRow?.refineChatModel).toBe(ARCHIVE_SETTINGS.refineChatModel);
  // THE key survived the settings restore.
  expect(settingsRow?.openRouterApiKey).toBe(KEY_SENTINEL);
});

it('"Keep both" through the UI leaves an existing picture untouched and skips it', async () => {
  await db.images.put(image('panel-a', [255, 254]));
  installPicker(await backupFile());
  renderPanel();
  const user = userEvent.setup();
  await chooseFile(user);

  expect(await screen.findByText('Images: 2 in the file — 1 new, 1 already here')).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Keep both' }));
  await user.click(screen.getByRole('button', { name: 'Import now' }));

  const result = await screen.findByLabelText('Import result');
  expect(
    within(result).getByText(
      'images: 1 added, 0 replaced, 1 skipped · runs: 1 added, 0 replaced, 0 skipped · conversations: 1 added, 0 replaced, 0 skipped · settings applied',
    ),
  ).toBeInTheDocument();
  expect(Array.from((await db.images.get('panel-a'))?.bytes ?? new Uint8Array())).toEqual([
    255, 254,
  ]);
});

it('"Replace existing" through the UI takes the file version', async () => {
  await db.images.put(image('panel-a', [255, 254]));
  installPicker(await backupFile());
  renderPanel();
  const user = userEvent.setup();
  await chooseFile(user);

  await user.click(await screen.findByRole('tab', { name: 'Replace existing' }));
  await user.click(screen.getByRole('button', { name: 'Import now' }));

  const result = await screen.findByLabelText('Import result');
  expect(
    within(result).getByText(
      'images: 1 added, 1 replaced, 0 skipped · runs: 1 added, 0 replaced, 0 skipped · conversations: 1 added, 0 replaced, 0 skipped · settings applied',
    ),
  ).toBeInTheDocument();
  expect(Array.from((await db.images.get('panel-a'))?.bytes ?? new Uint8Array())).toEqual([1, 2, 3]);
});

it('"Keep my settings" through the UI leaves the live settings row alone', async () => {
  await db.settings.put({
    id: 'settings',
    openRouterApiKey: KEY_SENTINEL,
    imageModel: 'live/model-before',
    refineChatModel: 'live/refine',
  });
  installPicker(await backupFile());
  renderPanel();
  const user = userEvent.setup();
  await chooseFile(user);

  await user.click(await screen.findByRole('tab', { name: 'Keep my settings' }));
  await user.click(screen.getByRole('button', { name: 'Import now' }));

  const result = await screen.findByLabelText('Import result');
  expect(within(result).getByText(/settings kept$/)).toBeInTheDocument();
  expect(await db.settings.get('settings')).toEqual({
    id: 'settings',
    openRouterApiKey: KEY_SENTINEL,
    imageModel: 'live/model-before',
    refineChatModel: 'live/refine',
  });
});

it('a cancelled picker says nothing at all and writes nothing', async () => {
  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  renderPanel();
  const user = userEvent.setup();
  await chooseFile(user);

  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Choose backup file…' })).toBeEnabled();
  });
  expect(screen.queryByText(/Backup loaded/)).toBeNull();
  expect(screen.queryByText(/Could not/)).toBeNull();
  expect(await db.images.count()).toBe(0);
});

it('a file that is not an Imager backup is a loud error and writes nothing', async () => {
  installPicker(new File([new Uint8Array([1, 2, 3, 4])], 'not-a-backup.zip'));
  renderPanel();
  const user = userEvent.setup();
  await chooseFile(user);

  expect(await screen.findByText('Could not load the backup')).toBeInTheDocument();
  expect(await screen.findByText(/not a readable ZIP archive/)).toBeInTheDocument();
  expect(await db.images.count()).toBe(0);
});
