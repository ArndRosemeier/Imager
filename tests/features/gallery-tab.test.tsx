import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { updateSettings } from '@/db/settingsRepo';
import { resetImageModelCache } from '@/llm/imageModels';
import { resetModelCache } from '@/llm/models';
import { jsonResponse, sourceFiles } from '../helpers';

/**
 * docs/17 row 30: the GALLERY TAB — the gallery lifted out of the Generate
 * area into its own top-level tab, the Generate tab reduced to the form, and
 * the two cross-tab actions ("Refine this" → Generate in Refine mode with that
 * source; "Chat with this image" → Chat, pinned in chat-attach.test.tsx)
 * rewired in `App`.
 */
const imagesModels = readFileSync('tests/fixtures/images-models-trimmed.json', 'utf8');
const SOURCE_ID = 'gallery-tab-source';
const SOURCE_PROMPT = 'seeded source for the gallery tab';
const IMAGE_MODEL = 'openai/gpt-image-1';
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

/** 64×32 is UNDER the reference cap, so the refine send path needs no codec. */
function decodeAt(width: number, height: number): () => Promise<ImageBitmap> {
  return () =>
    Promise.resolve({
      width,
      height,
      close: () => undefined,
    } as unknown as ImageBitmap);
}

async function seedSource(): Promise<void> {
  await db.images.put({
    id: SOURCE_ID,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    width: 64,
    height: 32,
    prompt: SOURCE_PROMPT,
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
    createdAt: 1,
    runId: '',
    favorite: false,
    tags: [],
  });
}

const sections = (): HTMLElement => screen.getByRole('tablist', { name: 'Sections' });
const mode = (): HTMLElement => screen.getByRole('tablist', { name: 'Generation mode' });

beforeEach(async () => {
  resetImageModelCache();
  resetModelCache();
  await Promise.all([db.settings.clear(), db.images.clear(), db.runs.clear(), db.conversations.clear()]);
  vi.stubGlobal('createImageBitmap', decodeAt(64, 32));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the app bar offers four tabs, the grid belongs to Gallery and Generate has none', async () => {
  stubFetch(() => jsonResponse({}));
  render(<App />);
  const user = userEvent.setup();

  expect(within(sections()).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Generate',
    'Gallery',
    'Chat',
    'Settings',
  ]);
  // Generate is the default and it is the FORM: the Create | Refine switch is
  // here and the grid is NOT (absence, not just presence).
  expect(screen.getByRole('tab', { name: 'Generate' })).toHaveAttribute('aria-selected', 'true');
  expect(mode()).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Gallery' })).toBeNull();

  // Gallery renders the grid — empty library, so the ONE quiet empty state.
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));
  const gallery = await screen.findByRole('region', { name: 'Gallery' });
  expect(within(gallery).getByText('No images yet.')).toBeInTheDocument();
  expect(within(sections()).getByRole('tab', { name: 'Gallery' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // ... and going back to Generate removes it again.
  await user.click(screen.getByRole('tab', { name: 'Generate' }));
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Gallery' })).toBeNull();
  });
});

it('"Refine this" lands on Generate, in Refine mode, with THAT image as the source', async () => {
  await seedSource();
  await updateSettings({ openRouterApiKey: 'sk', imageModel: IMAGE_MODEL });
  stubFetch(() =>
    jsonResponse({ data: [{ b64_json: btoa('refined'), media_type: 'image/png' }], usage: { cost: 0.3 } }),
  );
  render(<App />);
  const user = userEvent.setup();

  await user.click(screen.getByRole('tab', { name: 'Gallery' }));
  await user.click(await screen.findByRole('button', { name: `Open image: ${SOURCE_PROMPT}` }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Image details' })).getByRole('button', {
      name: 'Refine this',
    }),
  );

  // The active tab is Generate, the switch is on Refine ...
  expect(screen.getByRole('tab', { name: 'Generate' })).toHaveAttribute('aria-selected', 'true');
  expect(within(mode()).getByRole('tab', { name: 'Refine' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // ... and the source is THAT image (its own thumbnail, by its own prompt).
  expect(
    await screen.findByRole('img', { name: `Refinement source: ${SOURCE_PROMPT}` }),
  ).toBeInTheDocument();
  // The grid did NOT follow into the Generate tab as a second refine surface.
  expect(screen.queryByRole('region', { name: 'Gallery' })).toBeNull();

  // The strongest form of "THAT image": run it and read the request + the row.
  await user.type(screen.getByLabelText('Instruction'), 'make it colder');
  await user.click(screen.getByRole('button', { name: 'Refine' }));
  await waitFor(async () => {
    await expect(db.runs.count()).resolves.toBe(1);
  });
  const runs = await db.runs.toArray();
  expect(runs[0]).toMatchObject({ kind: 'refine', inputImageIds: [SOURCE_ID] });
  const sent = JSON.parse(posts[0] ?? '') as { input_references?: unknown[] };
  expect(sent.input_references).toHaveLength(1);
});

it('a freshly generated image is visible in the Gallery tab with no manual reload', async () => {
  await updateSettings({ openRouterApiKey: 'sk', imageModel: IMAGE_MODEL });
  stubFetch(() =>
    jsonResponse({
      data: [{ b64_json: btoa('fresh'), media_type: 'image/png' }],
      usage: { cost: 0.01 },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await screen.findByRole('combobox', { name: 'Aspect ratio' });
  await user.type(screen.getByLabelText('Prompt'), 'a fresh render');
  await user.click(screen.getByRole('button', { name: 'Generate' }));
  expect(await screen.findByText(/\$0\.0100/)).toBeInTheDocument();

  // Switching to the Gallery tab MOUNTS the grid, which reads the library — the
  // refresh mechanism is the mount, so there is no counter to keep alive.
  expect(screen.queryByRole('region', { name: 'Gallery' })).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'Gallery' }));
  const gallery = await screen.findByRole('region', { name: 'Gallery' });
  expect(
    await within(gallery).findByRole('button', { name: /Open image: a fresh render/ }),
  ).toBeInTheDocument();
});

// Rule 4: ONE place mounts the gallery. A second `<Gallery` (for example the
// old side-by-side split coming back inside GenerateArea) would be a second
// grid with its own load lifecycle.
it('exactly one src file mounts Gallery', () => {
  const hits = sourceFiles('src').filter((file) => readFileSync(file, 'utf8').includes('<Gallery'));
  expect(hits).toEqual(['src/App.tsx']);
});
