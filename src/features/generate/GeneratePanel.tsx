import { useEffect, useRef, useState } from 'react';

import type { Run } from '@/domain/image';
import { blockReason, useImagePanel } from '@/features/generate/useImagePanel';
import { runGeneration } from '@/features/generate/runGeneration';
import { RunStatus } from '@/features/generate/RunStatus';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/**
 * The text-to-image form. Layout only — the request path is
 * `runGeneration` → the ONE `src/llm/images.ts` seam, shared with refinement.
 */
export function GeneratePanel({
  onFinished,
}: Readonly<{ onFinished: () => void }>): React.JSX.Element {
  const { state, error } = useImagePanel();
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort(new DOMException('Generation cancelled', 'AbortError'));
    };
  }, []);

  if (error !== null) throw error;
  if (state === null) return <p>Loading settings…</p>;

  const reason = blockReason(state, prompt, 'Enter a prompt.');
  const maxCount = state.limits?.maxCount ?? 1;

  const onGenerate = (): void => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setLastRun(null);
    runGeneration({
      apiKey: state.settings.openRouterApiKey,
      model: state.settings.imageModel,
      prompt: prompt.trim(),
      n: Math.min(count, maxCount),
      aspectRatio: aspect === '' ? undefined : aspect,
      inputImageIds: [],
      signal: controller.signal,
    })
      .then(setLastRun, (runError: unknown) => {
        toastError('Image generation failed', runError);
        setLastRun({
          id: 'failed',
          kind: 'generate',
          prompt,
          model: state.settings.imageModel,
          inputImageIds: [],
          requestedCount: count,
          receivedCount: 0,
          filteredCount: 0,
          costUsd: null,
          createdAt: Date.now(),
          error: errorMessage(runError),
        });
      })
      .finally(() => {
        setBusy(false);
        abortRef.current = null;
        onFinished();
      });
  };

  return (
    <section
      aria-label="Generate"
      className="flex flex-col gap-2 self-start rounded border border-strong bg-surface p-3"
    >
      <p className="text-sm">
        Model:{' '}
        <span className="font-mono">
          {state.settings.imageModel === '' ? 'No model selected' : state.settings.imageModel}
        </span>
      </p>
      {state.limits !== null && !state.limits.listed && (
        <div
          role="alert"
          className="rounded border border-amber-400 bg-warn-surface p-2 text-on-warn-surface"
        >
          This model is not listed in OpenRouter&apos;s Images API limits — count is fixed at 1 and
          no aspect ratio is sent.
        </div>
      )}
      <label htmlFor="prompt" className="font-semibold">
        Prompt
      </label>
      <textarea
        id="prompt"
        className="rounded border border-strong bg-canvas p-2 text-ink"
        rows={3}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
        }}
      />
      <div className="flex gap-4">
        <label>
          Count{' '}
          <select
            aria-label="Count"
            className="rounded border border-strong bg-canvas text-ink"
            value={Math.min(count, maxCount)}
            onChange={(e) => {
              setCount(Number(e.target.value));
            }}
          >
            {Array.from({ length: maxCount }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {state.limits !== null && state.limits.aspectRatios.length > 0 && (
          <label>
            Aspect{' '}
            <select
              aria-label="Aspect ratio"
              className="rounded border border-strong bg-canvas text-ink"
              value={aspect}
              onChange={(e) => {
                setAspect(e.target.value);
              }}
            >
              <option value="">model default</option>
              {state.limits.aspectRatios.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded bg-accent px-3 py-1 text-on-accent disabled:opacity-50"
          disabled={reason !== null || busy}
          onClick={onGenerate}
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
        {busy && (
          <button
            type="button"
            className="rounded border border-strong px-3 py-1"
            onClick={() => {
              abortRef.current?.abort(new DOMException('Generation cancelled', 'AbortError'));
            }}
          >
            Cancel
          </button>
        )}
        {reason !== null && !busy && <span className="text-sm text-muted">{reason}</span>}
      </div>
      <RunStatus run={lastRun} />
    </section>
  );
}
