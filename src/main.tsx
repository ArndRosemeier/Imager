import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/index.css';
import { App } from '@/App';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { getTheme, setTheme } from '@/lib/theme';
import { toastError } from '@/lib/toast';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found — check index.html.');
}

// index.html's inline script already applied the persisted theme before
// paint; re-applying it through the ONE seam keeps the DOM, the persisted
// value and React's view of the theme in agreement (and covers anyone who
// opens the app without that script, e.g. a test harness).
setTheme(getTheme());

// Anything nothing else caught still reaches the one visible surface (rule 2).
window.addEventListener('error', (event) => {
  toastError('Unexpected error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  toastError('Unexpected error', event.reason);
});

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
