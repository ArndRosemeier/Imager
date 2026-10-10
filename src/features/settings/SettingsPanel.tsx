import { useCallback, useEffect, useState } from 'react';

import { ThemeToggle } from '@/components/ThemeToggle';
import { EmptyState } from '@/components/ui';
import { buttonClass } from '@/components/styles';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import type { Settings } from '@/domain/settings';
import { ExportPanel } from '@/features/export/ExportPanel';
import { ImportPanel } from '@/features/import/ImportPanel';
import { testApiKey } from '@/llm/key';
import {
  canGenerateAudio,
  canGenerateImages,
  canRefineViaChat,
  canWriteSongSheet,
  listModels,
  type OpenRouterModel,
} from '@/llm/models';
import { listVideoModels, type VideoModel } from '@/llm/video';
import { ModelPicker } from '@/features/settings/ModelPicker';
import { openRouterOption, videoOption } from '@/features/settings/modelOptions';
import { errorMessage, toError } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';

export function SettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [videoModels, setVideoModels] = useState<VideoModel[] | null>(null);
  const [videoModelsError, setVideoModelsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  /**
   * Bumped after an import: the export panel's counts and the model pickers
   * below both read the library/settings once, and an import changes both. A
   * remount key is the smallest honest refresh — the alternative is a panel
   * showing a count that is no longer true (rule 1).
   */
  const [libraryNonce, setLibraryNonce] = useState(0);

  const loadModels = useCallback((apiKey: string) => {
    setModelsError(null);
    listModels(apiKey).then(setModels, (error: unknown) => {
      setModelsError(errorMessage(error));
      toastError('Could not load the OpenRouter model list', error);
    });
  }, []);

  /** The video models are their own list (`GET /videos/models`, docs/17 row 56). */
  const loadVideoModels = useCallback((apiKey: string) => {
    setVideoModelsError(null);
    listVideoModels(apiKey).then(setVideoModels, (error: unknown) => {
      setVideoModelsError(errorMessage(error));
      toastError('Could not load the OpenRouter video-model list', error);
    });
  }, []);

  /**
   * After an import (docs/17 row 27) the library and possibly the settings have
   * changed: re-read the settings and remount the export panel so its counts are
   * the counts that are actually true.
   */
  const refreshAfterImport = useCallback((): void => {
    setLibraryNonce((nonce) => nonce + 1);
    getSettings().then(setSettings, (error: unknown) => {
      toastError('Could not reload settings after the import', error);
    });
  }, []);

  useEffect(() => {
    getSettings().then(
      (s) => {
        setSettings(s);
        setKeyDraft(s.openRouterApiKey);
        loadModels(s.openRouterApiKey);
        loadVideoModels(s.openRouterApiKey);
      },
      (error: unknown) => {
        setLoadError(toError(error));
      },
    );
  }, [loadModels, loadVideoModels]);

  // A corrupt settings row goes to the error boundary (rule 1/2).
  if (loadError !== null) throw loadError;
  if (settings === null) return <p className="text-body text-muted">Loading settings…</p>;

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

  const imageModels = models?.filter(canGenerateImages) ?? [];
  const refineModels = models?.filter(canRefineViaChat) ?? [];
  const musicModels = models?.filter(canGenerateAudio) ?? [];
  const writerModels = models?.filter(canWriteSongSheet) ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <section
        aria-label="Appearance"
        className="card flex flex-wrap items-center justify-between gap-2 p-3"
      >
        <h2 className="text-heading text-ink">Appearance</h2>
        <ThemeToggle />
      </section>

      <section aria-label="OpenRouter API key" className="card p-3">
        <label htmlFor="api-key" className="block text-label text-ink">
          OpenRouter API key
        </label>
        <p className="text-caption text-muted">
          Stored in this browser only — the app has no backend. Nothing is sent anywhere except to
          OpenRouter, with this key.
        </p>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          placeholder="sk-or-…"
          className="field focus-visible:field-focus hover:field-hover mt-2 font-mono"
          value={keyDraft}
          onChange={(e) => {
            setKeyDraft(e.target.value);
          }}
          onBlur={() => {
            if (keyDraft.trim() !== settings.openRouterApiKey)
              save({ openRouterApiKey: keyDraft.trim() });
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" className={buttonClass('primary')} disabled={testing} onClick={onTestKey}>
            {testing ? 'Testing…' : 'Test key'}
          </button>
          {settings.openRouterApiKey !== '' && (
            <span className="chip">key saved</span>
          )}
        </div>
      </section>

      {/*
        Getting the work OUT and back IN (docs/17 rows 25 and 27): the two
        export modes and the one import live in the Settings tab, where the
        app's own state is managed; the export panel is remounted after an
        import so its counts cannot go stale.
      */}
      <ExportPanel key={libraryNonce} />
      <ImportPanel onImported={refreshAfterImport} />

      {modelsError !== null && (
        <div
          role="alert"
          className="card flex flex-wrap items-center gap-2 border-danger bg-danger-surface p-3 text-on-danger-surface"
        >
          <span className="text-body">Model list failed to load: {modelsError}</span>
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              loadModels(settings.openRouterApiKey);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {models === null && modelsError === null && (
        <p className="text-body text-muted">Loading models…</p>
      )}
      {models !== null && modelsError === null && (
        <>
          <ModelPicker
            label="Image model"
            models={imageModels.map(openRouterOption)}
            selectedId={settings.imageModel}
            onSelect={(id) => {
              save({ imageModel: id });
            }}
          />
          <ModelPicker
            label="Refinement model"
            models={refineModels.map(openRouterOption)}
            selectedId={settings.refineChatModel}
            onSelect={(id) => {
              save({ refineChatModel: id });
            }}
          />
          <ModelPicker
            label="Music model"
            hint="Renders songs on the Music tab. Every model that outputs audio is listed; OpenRouter does not mark which are for music and which for speech."
            models={musicModels.map(openRouterOption)}
            selectedId={settings.musicModel}
            onSelect={(id) => {
              save({ musicModel: id });
            }}
          />
          <ModelPicker
            label="Song-writer model"
            hint="A text model that rewrites the song sheet from your directions on the Music tab. Only models with structured JSON output are listed."
            models={writerModels.map(openRouterOption)}
            selectedId={settings.songWriterModel}
            onSelect={(id) => {
              save({ songWriterModel: id });
            }}
          />
        </>
      )}
      {videoModelsError !== null && (
        <div
          role="alert"
          className="card flex flex-wrap items-center gap-2 border-danger bg-danger-surface p-3 text-on-danger-surface"
        >
          <span className="text-body">Video-model list failed to load: {videoModelsError}</span>
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              loadVideoModels(settings.openRouterApiKey);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {videoModels !== null && videoModelsError === null && (
        <ModelPicker
          label="Video model"
          hint="Generates videos on the Videos tab. Listed from OpenRouter's video models, with what each one supports."
          models={videoModels.map(videoOption)}
          selectedId={settings.videoModel}
          onSelect={(id) => {
            save({ videoModel: id });
          }}
        />
      )}
      {models !== null && models.length === 0 && (
        <EmptyState
          title="OpenRouter returned no models."
          hint="Check the API key, then Retry. The app will not guess a model for you."
        />
      )}
    </div>
  );
}
