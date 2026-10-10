import { useCallback, useEffect, useRef, useState } from 'react';

import { getLatestImageRun } from '@/db/imageRepo';
import type { Run, RunKind } from '@/domain/image';
import { toastError } from '@/lib/toast';

/**
 * The panel's "last run" state, seeded on mount with the newest run of `kind`
 * that stored images, so the latest result is still shown after leaving and
 * re-entering the Generate tab (docs/17 row 55). Once the panel sets a run
 * itself (a new generation starting), the mount-time read no longer applies.
 * ONE hook for both panels (rule 4).
 */
export function useLastRun(kind: RunKind): [Run | null, (run: Run | null) => void] {
  const [run, setRunState] = useState<Run | null>(null);
  const touched = useRef(false);
  useEffect(() => {
    let cancelled = false;
    getLatestImageRun(kind).then(
      (latest) => {
        if (!cancelled && !touched.current && latest !== undefined) setRunState(latest);
      },
      (error: unknown) => {
        if (!cancelled) toastError('Could not load the latest result', error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind]);
  const setRun = useCallback((next: Run | null) => {
    touched.current = true;
    setRunState(next);
  }, []);
  return [run, setRun];
}
