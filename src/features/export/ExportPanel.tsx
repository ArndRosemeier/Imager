import { useEffect, useState } from 'react';

import { SaveButton } from '@/components/ui';
import {
  ARCHIVE_MIME_TYPE,
  KEY_OMITTED_NOTE,
  buildLibraryArchive,
  exportFileName,
  formatBytes,
  libraryStats,
  type LibraryStats,
} from '@/features/export/exportLibrary';
import { toError } from '@/lib/errors';
import { type SaveRequest } from '@/lib/saveFile';

/**
 * "Save your work" — the owner's way OUT of the browser (docs/17 row 25).
 *
 * It lives in the Settings tab because that is where the app's own state is
 * managed, and because a destructive-looking "save everything" does not belong
 * next to the artwork. The two actions are deliberately explicit: what each one
 * contains is one line, and the OpenRouter key's absence is stated BEFORE the
 * save, from the same constant the manifest carries.
 *
 * Both actions go through the ONE `SaveButton` → `saveFile` seam, so the file
 * picker / anchor-download branch, the cancel-is-silent rule and the error
 * surface are not re-decided here.
 */

/** The request builder for one mode: fresh timestamp at click, build AFTER the
 * picker returns (see `saveFile`). */
function archiveRequest(mode: 'images' | 'backup'): SaveRequest {
  const now = new Date();
  return {
    fileName: exportFileName(mode, now),
    mimeType: ARCHIVE_MIME_TYPE,
    buildBytes: () => buildLibraryArchive(mode, now),
  };
}

export function ExportPanel(): React.JSX.Element {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  useEffect(() => {
    libraryStats().then(setStats, (error: unknown) => {
      setLoadError(toError(error));
    });
  }, []);
  // A library that cannot be counted is an error, not a zero (rule 1/2).
  if (loadError !== null) throw loadError;

  const imageSize = stats === null ? '' : `≈ ${formatBytes(stats.imageBytes)} of image data`;
  const backupSize =
    stats === null
      ? ''
      : `${stats.runCount} runs · ${stats.conversationCount} conversations · ${imageSize} + manifest`;

  return (
    <section aria-label="Save your work" className="card flex flex-col gap-3 p-3">
      <div>
        <h2 className="text-heading text-ink">Save your work</h2>
        <p className="text-caption text-muted">
          Everything here lives in this browser only — these two files are how you get it out.
        </p>
      </div>

      {stats === null ? (
        <p className="text-body text-muted">Checking what you have…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-label text-ink">All images — one ZIP</p>
              <p className="text-caption text-muted">
                Every picture in the gallery, one file each — no settings, no chats. Open it with
                any zip tool.
              </p>
              <p className="text-caption text-muted">
                {stats.imageCount === 0
                  ? 'Nothing to save yet — the gallery is empty.'
                  : `${stats.imageCount.toString()} images · ${imageSize}`}
              </p>
            </div>
            <SaveButton
              label="Save images ZIP"
              disabled={stats.imageCount === 0}
              buildRequest={() => archiveRequest('images')}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-strong pt-3">
            <div className="min-w-0">
              <p className="text-label text-ink">Everything — backup ZIP (Imager format)</p>
              <p className="text-caption text-muted">
                Imager's own format: a manifest with your settings, runs and chats, plus every
                image. This is the file to keep if you want to rebuild the library later.
              </p>
              <p className="text-caption text-muted">{backupSize}</p>
              <p className="text-caption text-muted">{KEY_OMITTED_NOTE}</p>
            </div>
            <SaveButton label="Save backup ZIP" buildRequest={() => archiveRequest('backup')} />
          </div>
        </>
      )}
    </section>
  );
}
