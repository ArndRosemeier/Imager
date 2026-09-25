import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { db } from '@/db/db';
import { THEME_STORAGE_KEY, getTheme, setTheme } from '@/lib/theme';
import { jsonResponse } from '../helpers';

beforeEach(async () => {
  await db.settings.clear();
  vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({})));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('defaults to dark with nothing stored, and the toggle applies + persists', async () => {
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  render(<App />);
  const group = screen.getByRole('group', { name: 'Theme' });
  expect(document.documentElement).toHaveClass('dark');
  expect(within(group).getByRole('button', { name: 'Dark' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await userEvent.setup().click(within(group).getByRole('button', { name: 'Light' }));
  expect(document.documentElement).not.toHaveClass('dark');
  expect(document.documentElement.style.colorScheme).toBe('light');
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  expect(within(group).getByRole('button', { name: 'Light' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('a stored preference wins over the dark default and survives a reload', async () => {
  // The pre-paint bootstrap in a real load; jsdom does not run it.
  setTheme('light');
  const first = render(<App />);
  expect(getTheme()).toBe('light');
  expect(document.documentElement).not.toHaveClass('dark');
  await userEvent.setup().click(
    within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'Dark' }),
  );
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  first.unmount();

  // Reload: the seam re-applies the persisted choice (exactly what
  // index.html's inline copy does before paint — pinned in the architecture
  // test), and the UI shows that theme.
  setTheme(getTheme());
  render(<App />);
  expect(document.documentElement).toHaveClass('dark');
  expect(
    within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'Dark' }),
  ).toHaveAttribute('aria-pressed', 'true');
});
