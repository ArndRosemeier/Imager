import { useState } from 'react';

import { buttonClass } from '@/components/styles';
import { Segmented } from '@/components/ui';
import { ARCHIVE_MIME_TYPE } from '@/features/export/exportLibrary';
import {
  CONFLICT_CHOICES,
  SETTINGS_CHOICES,
  applyImport,
  importResultSummary,
  previewImport,
  readLibraryArchive,
  type ConflictChoice,
  type ImportPreview,
  type ImportResult,
  type SettingsChoice,
  type ValidatedArchive,
} from '@/features/import/importLibrary';
import { openFile } from '@/lib/openFile';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * "Load your work" — the owner's way back IN (docs/17 row 27), the counterpart
 * of the "Save your work" section above it and in the same Settings tab for the
 * same reason: this is the app's own state, and it does not belong next to the
 * artwork.
 *
 * THE FLOW IS THE OWNER'S TWO DECISIONS MADE EXPLICIT: choose a file → a
 * validated PREVIEW (what is inside, from when, how many of each, and — for
 * each re-import conflict option — what would happen) → the conflict and
 * settings choices → confirm → an honest result summary. Nothing is written
 * before the confirm, and the OpenRouter key is never requested, shown or
 * written.
 *
 * The file open goes through the ONE `openFile` seam (the mirror of
 * `saveFile`): a cancelled picker is SILENT — no toast, no state change —
 * because the owner changing his mind is not an event.
 */

interface Loaded {
  archive: ValidatedArchive;
  preview: ImportPreview;
  fileName: string;
}

const OPEN_REQUEST = {
  description: 'Imager backup',
  extensions: ['.zip'],
  mimeType: ARCHIVE_MIME_TYPE,
} as const;

/** One line per table: what is in the file, and how it meets the library. */
function planLine(label: string, plan: ImportPreview['images']): string {
  return `${label}: ${plan.incoming.toString()} in the file — ${plan.fresh.toString()} new, ${plan.existing.toString()} already here`;
}

function madeLabel(exportedAt: string): string {
  const made = new Date(exportedAt);
  return Number.isNaN(made.getTime()) ? exportedAt : made.toLocaleString();
}

export function ImportPanel({
  onImported,
}: Readonly<{
  /** Called after a successful import, so the surrounding Settings tab (and the
   * export counts beside it) can re-read what is now in the library. */
  onImported?: () => void;
}>): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictChoice>(CONFLICT_CHOICES[0]);
  const [settingsChoice, setSettingsChoice] = useState<SettingsChoice>(SETTINGS_CHOICES[0]);

  /** Read and validate the chosen file; a real failure is loud (rule 2). */
  const load = async (bytes: Uint8Array<ArrayBuffer>, fileName: string): Promise<void> => {
    const archive = await readLibraryArchive(bytes);
    const preview = await previewImport(archive);
    setResult(null);
    setLoaded({ archive, preview, fileName });
  };

  const onChoose = (): void => {
    setBusy(true);
    openFile(OPEN_REQUEST).then(
      (outcome) => {
        if (outcome.status === 'cancelled') {
          // The owner changed his mind: nothing to say and nothing to undo.
          setBusy(false);
          return;
        }
        load(outcome.file.bytes, outcome.file.fileName)
          .catch((error: unknown) => {
            toastError('Could not load the backup', error);
          })
          .finally(() => {
            setBusy(false);
          });
      },
      (error: unknown) => {
        setBusy(false);
        toastError('Could not open the backup file', error);
      },
    );
  };

  const onConfirm = (): void => {
    if (loaded === null) return;
    setBusy(true);
    applyImport(loaded.archive, { conflict, settings: settingsChoice })
      .then((applied) => {
        setResult(applied);
        toastSuccess('Backup loaded', importResultSummary(applied));
        onImported?.();
      }, (error: unknown) => {
        toastError('Could not import the backup', error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-label="Load a backup" className="card flex flex-col gap-3 p-3">
      <div>
        <h2 className="text-heading text-ink">Load your work</h2>
        <p className="text-caption text-muted">
          Restore a backup ZIP made with the action above — Imager&apos;s own format, with the
          manifest. An images-only ZIP cannot be loaded: it carries no manifest.
        </p>
        <p className="text-caption text-muted">
          A backup never contains your OpenRouter API key, and loading one never changes it.
        </p>
      </div>

      {loaded === null ? (
        <div>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('secondary')}
            onClick={onChoose}
          >
            {busy ? 'Opening…' : 'Choose backup file…'}
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2 border-t border-strong pt-3">
            <div className="min-w-0">
              <p className="text-label text-ink">{loaded.fileName}</p>
              <p className="text-caption text-muted">Made {madeLabel(loaded.preview.exportedAt)}</p>
              <p className="text-caption text-muted">{planLine('Images', loaded.preview.images)}</p>
              <p className="text-caption text-muted">{planLine('Runs', loaded.preview.runs)}</p>
              <p className="text-caption text-muted">
                {planLine('Conversations', loaded.preview.conversations)}
              </p>
              <p className="text-caption text-muted">
                Settings in the file: image model {loaded.preview.settings.imageModel || '(none)'},
                refinement model {loaded.preview.settings.refineChatModel || '(none)'}.
              </p>
              {loaded.preview.danglingImageIds.length > 0 && (
                <p className="text-caption text-muted">
                  Note: {loaded.preview.danglingImageIds.length.toString()} referenced image
                  {loaded.preview.danglingImageIds.length === 1 ? ' is' : 's are'} missing from both
                  the file and your library ({loaded.preview.danglingImageIds.join(', ')}). The runs
                  and chats that point at them are still imported.
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={busy}
              className={buttonClass('ghost')}
              onClick={() => {
                setLoaded(null);
                setResult(null);
              }}
            >
              Cancel
            </button>
          </div>

          <div className="border-t border-strong pt-3">
            <p className="text-label text-ink">When an id is already in your library</p>
            <div className="mt-1">
              <Segmented
                label="When an id already exists"
                options={CONFLICT_CHOICES}
                value={conflict}
                onChange={(next) => {
                  setConflict(next);
                }}
              />
            </div>
            <p className="mt-1 text-caption text-muted">
              {conflict === 'Keep both'
                ? `Adds ${loaded.preview.images.fresh.toString()} new images, ${loaded.preview.runs.fresh.toString()} runs and ${loaded.preview.conversations.fresh.toString()} conversations; leaves the ${(loaded.preview.images.existing + loaded.preview.runs.existing + loaded.preview.conversations.existing).toString()} rows you already have exactly as they are.`
                : `Adds ${loaded.preview.images.fresh.toString()} new images, ${loaded.preview.runs.fresh.toString()} runs and ${loaded.preview.conversations.fresh.toString()} conversations; overwrites the ${(loaded.preview.images.existing + loaded.preview.runs.existing + loaded.preview.conversations.existing).toString()} rows you already have with the file's version.`}
            </p>
          </div>

          <div>
            <p className="text-label text-ink">Settings from the file</p>
            <div className="mt-1">
              <Segmented
                label="Settings from the file"
                options={SETTINGS_CHOICES}
                value={settingsChoice}
                onChange={(next) => {
                  setSettingsChoice(next);
                }}
              />
            </div>
            <p className="mt-1 text-caption text-muted">
              {settingsChoice === 'Apply settings'
                ? 'Your image and refinement model picks are set from the file. Your OpenRouter API key is not in the file and is left untouched.'
                : 'Your settings are left exactly as they are.'}
            </p>
          </div>

          <div>
            <button
              type="button"
              disabled={busy}
              className={buttonClass('primary')}
              onClick={onConfirm}
            >
              {busy ? 'Importing…' : 'Import now'}
            </button>
          </div>

          {result !== null && (
            <div aria-label="Import result" className="border-t border-strong pt-3">
              <p className="text-label text-ink">Imported</p>
              <p className="text-caption text-muted">{importResultSummary(result)}</p>
              <p className="text-caption text-muted">
                {result.settingsApplied
                  ? 'Settings applied from the file; your OpenRouter API key is unchanged.'
                  : 'Your settings were left unchanged.'}
              </p>
              {result.danglingImageIds.length > 0 && (
                <p className="text-caption text-muted">
                  Unresolved image references (imported anyway): {result.danglingImageIds.join(', ')}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
