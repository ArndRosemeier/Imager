import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { resetModelCache } from '@/llm/models';
import { jsonResponse, modelsFixture } from '../helpers';

beforeEach(async () => {
  resetModelCache();
  await db.settings.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(keyResponse: () => Response): void {
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve(url.endsWith('/key') ? keyResponse() : jsonResponse(modelsFixture())),
  );
}

it('shows "No model selected" for both pickers and filters by capability', async () => {
  stubFetch(() => jsonResponse({}, 500));
  render(<App />);
  const image = await screen.findByRole('region', { name: 'Image model' });
  const refine = screen.getByRole('region', { name: 'Refinement chat model' });
  expect(within(image).getByText('No model selected')).toBeInTheDocument();
  expect(within(refine).getByText('No model selected')).toBeInTheDocument();
  expect(within(image).getAllByRole('option')).toHaveLength(9);
  expect(within(refine).getAllByRole('option')).toHaveLength(7);
  expect(within(refine).queryByText('recraft/recraft-v4.1-flash')).toBeNull();

  const user = userEvent.setup();
  await user.type(within(image).getByRole('searchbox'), 'gemini');
  expect(within(image).getAllByRole('option')).toHaveLength(2);
  await user.click(within(image).getByText('google/gemini-2.5-flash-image'));
  expect(
    await within(image).findByText(/Selected: .*\(google\/gemini-2.5-flash-image\)/),
  ).toBeInTheDocument();
});

it('Test key: 401 surfaces a visible error', async () => {
  stubFetch(() => jsonResponse({ error: { code: 401, message: 'User not found.' } }, 401));
  render(<App />);
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText('OpenRouter API key', { selector: 'input' }),
    'sk-bad',
  );
  await user.click(screen.getByRole('button', { name: 'Test key' }));
  expect(await screen.findByText('API key test failed')).toBeInTheDocument();
  expect(await screen.findByText(/401.*User not found/)).toBeInTheDocument();
});

it('Test key: 200 surfaces a visible success', async () => {
  stubFetch(() =>
    jsonResponse({ data: { label: 'sk-or-v1-abc...xyz', limit_remaining: null, usage: 0 } }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText('OpenRouter API key', { selector: 'input' }),
    'sk-good',
  );
  await user.click(screen.getByRole('button', { name: 'Test key' }));
  expect(await screen.findByText('API key is valid')).toBeInTheDocument();
});

it('a /models failure is a visible error, not an empty picker', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({ nope: true })));
  render(<App />);
  expect(await screen.findByText(/Model list failed to load/)).toBeInTheDocument();
});
