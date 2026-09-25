import { useCallback, useEffect, useState } from 'react';

import { ThemeToggle } from '@/components/ThemeToggle';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import type { Settings } from '@/domain/settings';
import { testApiKey } from '@/llm/key';
import {
  canGenerateImages,
  canRefineViaChat,
  listModels,
  type OpenRouterModel,
} from '@/llm/models';
import { ModelPicker } from '@/features/settings/ModelPicker';
import { errorMessage, toError } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';

export function SettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);

  const loadModels = useCallback((apiKey: string) => {
    setModelsError(null);
    listModels(apiKey).then(setModels, (error: unknown) => {
      setModelsError(errorMessage(error));
      toastError('Could not load the OpenRouter model list', error);
    });
  }, []);

  useEffect(() => {
    getSettings().then(
      (s) => {
        setSettings(s);
        setKeyDraft(s.openRouterApiKey);
        loadModels(s.openRouterApiKey);
      },
      (error: unknown) => {
        setLoadError(toError(error));
      },
    );
  }, [loadModels]);

  // A corrupt settings row goes to the error boundary (rule 1/2).
  if (loadError !== null) throw loadError;
  if (settings === null) return <p>Loading settings…</p>;

  const save = (patch: Partial<Settings>): void => {
    updateSettings(patch).then(setSettings, (error: unknown) => {
      toastError('Could not save settings', error);
    });
  };

  const onTestKey = (): void => {
    setTesting(true);
    save({ openRouterApiKey: keyDraft.trim() });
    testApiKey(keyDraft)
      .then(
        (info) => {
          toastSuccess('API key is valid', `Key "${info.label}"`);
        },
        (error: unknown) => {
          toastError('API key test failed', error);
        },
      )
      .finally(() => {
        setTesting(false);
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Appearance"
        className="flex flex-wrap items-center justify-between gap-2 rounded border border-strong bg-surface p-3"
      >
        <h2 className="font-semibold">Appearance</h2>
        <ThemeToggle />
      </section>
      <section
        aria-label="OpenRouter API key"
        className="rounded border border-strong bg-surface p-3"
      >
        <label htmlFor="api-key" className="block font-semibold">
          OpenRouter API key
        </label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          className="w-full rounded border border-strong bg-canvas px-2 py-1 font-mono text-ink"
          value={keyDraft}
          onChange={(e) => {
            setKeyDraft(e.target.value);
          }}
          onBlur={() => {
            if (keyDraft.trim() !== settings.openRouterApiKey)
              save({ openRouterApiKey: keyDraft.trim() });
          }}
        />
        <button
          type="button"
          className="mt-2 rounded bg-accent px-3 py-1 text-on-accent disabled:opacity-50"
          disabled={testing}
          onClick={onTestKey}
        >
          {testing ? 'Testing…' : 'Test key'}
        </button>
      </section>

      {modelsError !== null && (
        <div
          role="alert"
          className="rounded border border-danger bg-danger-surface p-3 text-on-danger-surface"
        >
          Model list failed to load: {modelsError}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              loadModels(settings.openRouterApiKey);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {models === null && modelsError === null && <p>Loading models…</p>}
      {models !== null && (
        <>
          <ModelPicker
            label="Image model"
            models={models.filter(canGenerateImages)}
            selectedId={settings.imageModel}
            onSelect={(id) => {
              save({ imageModel: id });
            }}
          />
          <ModelPicker
            label="Refinement model"
            models={models.filter(canRefineViaChat)}
            selectedId={settings.refineChatModel}
            onSelect={(id) => {
              save({ refineChatModel: id });
            }}
          />
        </>
      )}
    </div>
  );
}
