import { useCallback, useEffect, useState } from 'react';

import { saveImageFile } from '@/db/imageRepo';
import { toastError, toastSuccess } from '@/lib/toast';

/** True for a paste aimed at a text field: the text belongs to the field, not the gallery. */
function isTextTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  );
}

/** A pasted screenshot is named `image.png` by every browser; the time tells two apart. */
function namePasted(file: File): File {
  if (file.name !== '' && file.name !== 'image.png') return file;
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const extension = file.type.split('/')[1] ?? 'png';
  return new File([file], `Pasted image ${stamp}.${extension}`, { type: file.type });
}

/**
 * THE gallery import (docs/17 row 65): image files chosen with the Import
 * button AND images pasted into the page both come here, and both go through
 * `saveImageFile` — the app's one device-file → gallery-row path, which also
 * refuses duplicates by content. Each file is its own outcome: one that cannot
 * be read as an image toasts its own error and the rest still land. The result
 * is named, so "already there" is never mistaken for "nothing happened".
 */
export function useImageImport(
  knownIds: ReadonlySet<string>,
  onChanged: () => void,
): { importFiles: (files: readonly File[]) => Promise<void>; importing: boolean } {
  const [importing, setImporting] = useState(false);

  const importFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      setImporting(true);
      const seen = new Set(knownIds);
      let added = 0;
      let already = 0;
      try {
        for (const file of files) {
          try {
            const image = await saveImageFile(file);
            if (seen.has(image.id)) already += 1;
            else added += 1;
            seen.add(image.id);
          } catch (error: unknown) {
            toastError(`Could not import ${file.name}`, error);
          }
        }
      } finally {
        setImporting(false);
        onChanged();
      }
      if (added > 0 || already > 0) {
        const parts = [
          added > 0 ? `${String(added)} added to the gallery` : null,
          already > 0 ? `${String(already)} already in the gallery` : null,
        ].filter((part) => part !== null);
        toastSuccess('Import finished', parts.join(', '));
      }
    },
    [knownIds, onChanged],
  );

  return { importFiles, importing };
}

/**
 * Paste an image anywhere on the Gallery tab. Only clipboard FILES that are
 * images are taken — pasted text is left alone, and so is any paste into a
 * text field (the tag editor). `paste` delivers the data with the event, so
 * this reads no clipboard API and needs no permission.
 */
export function useImagePaste(onImages: (files: File[]) => Promise<void>): void {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (isTextTarget(event.target)) return;
      const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
        file.type.startsWith('image/'),
      );
      if (images.length === 0) return;
      event.preventDefault();
      void onImages(images.map(namePasted));
    };
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('paste', onPaste);
    };
  }, [onImages]);
}
