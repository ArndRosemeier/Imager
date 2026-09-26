/**
 * DISPATCHER's own verification of docs/17 row 30 — the gallery-as-its-own-tab
 * split. Written independently of the writer's suite: it asserts the ABSENCE of
 * the grid on Generate (the half a "presence" pin cannot see) and that the
 * form-only Generate tab did not lose the controls it still needs.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { resetImageModelCache } from '@/llm/imageModels';
import { resetModelCache } from '@/llm/models';
import { jsonResponse } from '../helpers';

const imagesModels = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');

beforeEach(async () => {
  resetImageModelCache();
  resetModelCache();
  await Promise.all([
    db.settings.clear(),
    db.images.clear(),
    db.runs.clear(),
    db.conversations.clear(),
  ]);
  vi.stubGlobal('fetch', (url: string) => {
    if (url.endsWith('/images/models')) return Promise.resolve(new Response(imagesModels));
    return Promise.resolve(jsonResponse({ data: [] }));
  });
  URL.createObjectURL = vi.fn(() => 'blob:cos');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('COS: the grid is on the Gallery tab and ABSENT from the form-only Generate tab', async () => {
  const user = userEvent.setup();
  render(<App />);

  // Four tabs, in order.
  expect(screen.getAllByRole('tab').slice(0, 4).map((t) => t.textContent)).toEqual([
    'Generate',
    'Gallery',
    'Chat',
    'Settings',
  ]);

  // Generate starts active: the form is there, the grid is NOT. The settings
  // read is async, so the form's arrival is awaited (a synchronous check races
  // the "Loading settings…" state — the dispatcher's own test bug).
  expect(await screen.findByLabelText('Prompt')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Gallery' })).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'Gallery' }));

  // The grid is there now, and the form is NOT (one job per tab).
  expect(await screen.findByRole('region', { name: 'Gallery' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Prompt')).toBeNull();
});

it('COS: an empty library on the Gallery tab shows an honest empty state, not a blank panel', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));

  const gallery = await screen.findByRole('region', { name: 'Gallery' });
  expect(within(gallery).getByText(/no images yet/i)).toBeInTheDocument();
});

it('COS: a stored image is listed in the Gallery tab on arrival (no refresh plumbing)', async () => {
  await db.images.put({
    id: 'cos-gallery-1',
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 8,
    height: 8,
    prompt: 'cos gallery tab probe',
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: Date.now(),
    runId: '',
    favorite: false,
  });

  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));

  expect(
    await screen.findByRole('button', { name: 'Open image: cos gallery tab probe' }),
  ).toBeInTheDocument();
});
