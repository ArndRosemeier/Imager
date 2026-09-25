import { useEffect, useRef, useState } from 'react';

import { getSettings } from '@/db/settingsRepo';
import type { Run } from '@/domain/image';
import type { Settings } from '@/domain/settings';
import { runGeneration } from '@/features/generate/runGeneration';
import { Gallery } from '@/features/gallery/Gallery';
import { limitsFor, listImageModelLimits, type ImageModelLimits } from '@/llm/imageModels';
import { errorMessage, toError } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/** Why Generate is disabled, or null when it may run. */
function blockReason(
  settings: Settings,
  prompt: string,
  limits: ImageModelLimits | null,
): string | null {
  if (settings.openRouterApiKey === '') return 'Enter an OpenRouter API key in Settings.';
  if (settings.imageModel === '') return 'No image model selected — pick a model in Settings.';
  if (limits === null) return 'Loading model limits…';
  if (prompt.trim() === '') return 'Enter a prompt.';
  return null;
}

export function GeneratePanel(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [limits, setLimits] = useState<ImageModelLimits | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [galleryVersion, setGalleryVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getSettings().then(
      (s) => {
        setSettings(s);
        if (s.imageModel === '') return;
        listImageModelLimits(s.openRouterApiKey).then(
          (all) => {
            setLimits(limitsFor(all, s.imageModel));
          },
          (error: unknown) => {
            setLimitsError(errorMessage(error));
            toastError('Could not load the image-model limits', error);
          },
        );
      },
      (error: unknown) => {
        setLoadError(toError(error));
      },
    );
  }, []);

  if (loadError !== null) throw loadError;
  if (settings === null) return <p>Loading settings…</p>;

  const reason =
    limitsError === null
      ? blockReason(settings, prompt, limits)
      : `Model limits failed to load: ${limitsError}`;
  const maxCount = limits?.maxCount ?? 1;

  const onGenerate = (): void => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setLastRun(null);
    runGeneration({
      apiKey: settings.openRouterApiKey,
      model: settings.imageModel,
      prompt: prompt.trim(),
      n: Math.min(count, maxCount),
      aspectRatio: aspect === '' ? undefined : aspect,
      signal: controller.signal,
    })
      .then(setLastRun, (error: unknown) => {
        toastError('Image generation failed', error);
        setLastRun({
          id: 'failed',
          prompt,
          model: settings.imageModel,
          requestedCount: count,
          receivedCount: 0,
          filteredCount: 0,
          costUsd: null,
          createdAt: Date.now(),
          error: errorMessage(error),
        });
      })
      .finally(() => {
        setBusy(false);
        abortRef.current = null;
        setGalleryVersion((v) => v + 1);
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Generate"
        className="flex flex-col gap-2 rounded border border-gray-300 p-3"
      >
        <p className="text-sm">
          Model:{' '}
          <span className="font-mono">
            {settings.imageModel === '' ? 'No model selected' : settings.imageModel}
          </span>
        </p>
        {limits !== null && !limits.listed && (
          <div
            role="alert"
            className="rounded border border-amber-400 bg-amber-50 p-2 text-amber-900"
          >
            This model is not listed in OpenRouter&apos;s Images API limits — count is fixed at 1
            and no aspect ratio is sent.
          </div>
        )}
        <label htmlFor="prompt" className="font-semibold">
          Prompt
        </label>
        <textarea
          id="prompt"
          className="rounded border p-2"
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
          {limits !== null && limits.aspectRatios.length > 0 && (
            <label>
              Aspect{' '}
              <select
                aria-label="Aspect ratio"
                value={aspect}
                onChange={(e) => {
                  setAspect(e.target.value);
                }}
              >
                <option value="">model default</option>
                {limits.aspectRatios.map((a) => (
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
            className="rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50"
            disabled={reason !== null || busy}
            onClick={onGenerate}
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
          {busy && (
            <button
              type="button"
              className="rounded border px-3 py-1"
              onClick={() => {
                abortRef.current?.abort(new DOMException('Generation cancelled', 'AbortError'));
              }}
            >
              Cancel
            </button>
          )}
          {reason !== null && !busy && <span className="text-sm text-gray-700">{reason}</span>}
        </div>
        {lastRun !== null && (
          <div role="status" className={lastRun.error === null ? 'text-green-800' : 'text-red-800'}>
            {lastRun.error === null ? (
              <>
                Received {lastRun.receivedCount} of {lastRun.requestedCount}.{' '}
                {lastRun.filteredCount > 0 &&
                  `${String(lastRun.filteredCount)} of ${String(lastRun.receivedCount + lastRun.filteredCount)} candidates were filtered. `}
                Cost: {lastRun.costUsd === null ? 'not reported' : `$${lastRun.costUsd.toFixed(4)}`}
              </>
            ) : (
              <>Run failed: {lastRun.error}</>
            )}
          </div>
        )}
      </section>
      <Gallery version={galleryVersion} />
    </div>
  );
}
