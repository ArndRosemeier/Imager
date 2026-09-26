import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { resetImageModelCache } from '@/llm/imageModels';
import { jsonResponse } from '../helpers';

const imagesModels = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');
let posts: string[] = [];

function stubFetch(imagesBody: () => Response): void {
  posts = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/images/models')) return Promise.resolve(new Response(imagesModels));
    if (url.endsWith('/images')) {
      posts.push(init?.body as string);
      return Promise.resolve(imagesBody());
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

beforeEach(async () => {
  resetImageModelCache();
  await Promise.all([db.settings.clear(), db.images.clear(), db.runs.clear()]);
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 64, height: 32, close: () => undefined }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('no model selected → Generate disabled with the reason, no request sent', async () => {
  stubFetch(() => jsonResponse({}));
  await updateSettings({ openRouterApiKey: 'sk' });
  render(<App />);
  expect(await screen.findByText(/pick a model in Settings/)).toBeInTheDocument();
  await userEvent.setup().type(screen.getByLabelText('Prompt'), 'a cat');
  expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  expect(posts).toEqual([]);
});

it('count never exceeds the model’s published n max; unlisted → notice + 1', async () => {
  stubFetch(() => jsonResponse({}));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: 'recraft/recraft-v3' });
  const { unmount } = render(<App />);
  await screen.findByRole('combobox', { name: 'Aspect ratio' });
  expect(
    within(screen.getByRole('combobox', { name: 'Count' })).getAllByRole('option'),
  ).toHaveLength(6);
  unmount();

  await updateSettings({ imageModel: 'nobody/unlisted' });
  render(<App />);
  expect(await screen.findByText(/not listed in OpenRouter/)).toBeInTheDocument();
  expect(
    within(screen.getByRole('combobox', { name: 'Count' })).getAllByRole('option'),
  ).toHaveLength(1);
});

it('success stores N images + 1 run and shows them in the gallery with the filter count', async () => {
  stubFetch(() =>
    jsonResponse({
      data: [
        { b64_json: btoa('a'), media_type: 'image/png' },
        { b64_json: btoa('b'), media_type: 'image/png' },
        null,
      ],
      usage: { cost: 0.12 },
    }),
  );
  await updateSettings({ openRouterApiKey: 'sk', imageModel: 'openai/gpt-image-1' });
  render(<App />);
  const user = userEvent.setup();
  await screen.findByRole('combobox', { name: 'Aspect ratio' });
  await user.type(screen.getByLabelText('Prompt'), 'a red fox');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Count' }), '3');
  await user.click(screen.getByRole('button', { name: 'Generate' }));
  expect(await screen.findByText(/1 of 3 candidates were filtered/)).toBeInTheDocument();
  expect(screen.getByText(/\$0\.1200/)).toBeInTheDocument();
  expect(JSON.parse(posts[0] ?? '')).toMatchObject({ n: 3, model: 'openai/gpt-image-1' });
  const gallery = screen.getByRole('region', { name: 'Gallery' });
  expect(
    await within(gallery).findAllByRole('button', { name: /Open image: a red fox/ }),
  ).toHaveLength(2);
  await expect(db.images.count()).resolves.toBe(2);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    requestedCount: 3,
    receivedCount: 2,
    filteredCount: 1,
    costUsd: 0.12,
    error: null,
  });

  const [first] = within(gallery).getAllByRole('button', { name: /Open image/ });
  if (first === undefined) throw new Error('no thumbnail');
  await user.click(first);
  const dialog = screen.getByRole('dialog', { name: 'Image details' });
  // The lightbox's ONE save control is the shared SaveButton (docs/17 row 25):
  // a real "Save as…" through the save seam, not a hand-rolled anchor.
  expect(within(dialog).getByRole('button', { name: /Save as/ })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => {
    expect(within(gallery).getAllByRole('button', { name: /Open image/ })).toHaveLength(1);
  });
  await expect(db.images.count()).resolves.toBe(1);
});

it('a 200 error envelope → failed run row + visible error + toast, zero images', async () => {
  stubFetch(() => jsonResponse({ error: { code: 400, message: 'Prompt was refused' } }));
  await updateSettings({ openRouterApiKey: 'sk', imageModel: 'google/gemini-2.5-flash-image' });
  render(<App />);
  const user = userEvent.setup();
  await screen.findByRole('combobox', { name: 'Aspect ratio' });
  await user.type(screen.getByLabelText('Prompt'), 'x');
  await user.click(screen.getByRole('button', { name: 'Generate' }));
  expect(await screen.findByText(/Run failed: .*Prompt was refused/)).toBeInTheDocument();
  expect(await screen.findByText('Image generation failed')).toBeInTheDocument();
  await expect(db.images.count()).resolves.toBe(0);
  const runs = await db.runs.toArray();
  expect(runs).toHaveLength(1);
  expect(runs[0]?.error).toMatch(/Prompt was refused/);
});
