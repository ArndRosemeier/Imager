import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { App } from '@/App';

it('renders the Imager heading and settles the Generate tab', async () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Imager' })).toBeInTheDocument();
  // Await the async settings read so nothing resolves after teardown.
  expect(await screen.findByText(/Enter an OpenRouter API key in Settings/)).toBeInTheDocument();
});
