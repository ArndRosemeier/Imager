import { Component, type ErrorInfo, type ReactNode } from 'react';

import { buttonClass } from '@/components/styles';
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
          className="card m-6 border-danger bg-danger-surface p-4 text-on-danger-surface"
        >
          <h2 className="text-heading">Something went wrong</h2>
          <p className="mt-2 font-mono text-caption">{errorMessage(this.state.error)}</p>
          <button
            type="button"
            className={`${buttonClass('danger')} mt-3`}
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
