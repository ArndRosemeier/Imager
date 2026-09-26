import type { Run } from '@/domain/image';

/**
 * The one result line for a run (create or refine): counts, the filtered
 * candidates the API dropped, and the cost, or the run's failure message.
 * Extracted so the two panels cannot drift on how a partial/filtered result
 * is reported (rule 4).
 */
export function RunStatus({ run }: Readonly<{ run: Run | null }>): React.JSX.Element | null {
  if (run === null) return null;
  return (
    <p
      role="status"
      className={`text-caption ${run.error === null ? 'text-ok' : 'text-danger'}`}
    >
      {run.error === null ? (
        <>
          Received {run.receivedCount} of {run.requestedCount}.{' '}
          {run.filteredCount > 0 &&
            `${String(run.filteredCount)} of ${String(run.receivedCount + run.filteredCount)} candidates were filtered. `}
          Cost: {run.costUsd === null ? 'not reported' : `$${run.costUsd.toFixed(4)}`}
        </>
      ) : (
        <>Run failed: {run.error}</>
      )}
    </p>
  );
}
