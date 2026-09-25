import { Component, type ErrorInfo, type ReactNode } from 'react';

import { errorMessage } from '@/lib/errors';

interface State {
  error: unknown;
}

/** Top-level boundary: a render crash shows its message on screen (rule 2). */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Devtools copy in addition to the visible surface below.
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          className="m-6 rounded border border-danger bg-danger-surface p-4 text-on-danger-surface"
        >
          <h2 className="font-semibold">Something went wrong</h2>
          <p className="mt-2 font-mono text-sm">{errorMessage(this.state.error)}</p>
          <button
            type="button"
            className="mt-3 rounded bg-danger px-3 py-1 text-white"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
