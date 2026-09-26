import { useEffect, useState } from 'react';

import { getImage, saveUploadedImage } from '@/db/imageRepo';
import type { StoredImage } from '@/domain/image';
import type { ChatAttachRequest } from '@/features/chat/attachRequest';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';

/**
 * A staged image is an ordinary gallery row — this hook never invents state for
 * it, it only holds the rows the composer will send with the NEXT message.
 */

/**
 * The ONE staged-attachment state for the chat composer (docs/17 row 18).
 *
 * BOTH ways in — the composer's file control AND a gallery image handed over by
 * `App` as a `ChatAttachRequest` — land in THIS state. The state itself (not
 * just the callers) lives here so there is exactly ONE place it exists: the
 * architecture pin counts the hook, not the components.
 *
 * `size()` is derived state, never a counter that can drift.
 */
export function useStagedAttachment(
  attachRequest: ChatAttachRequest | undefined,
  onAttachConsumed: (nonce: number) => void,
): {
  attached: StoredImage[];
  add: (image: StoredImage) => void;
  addFile: (file: File) => Promise<void>;
  remove: (id: string) => void;
  takeAll: () => StoredImage[];
  restore: (images: StoredImage[]) => void;
  busy: boolean;
  error: string | null;
} {
  const [attached, setAttached] = useState<StoredImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = (image: StoredImage): void => {
    setAttached((prev) => (prev.some((row) => row.id === image.id) ? prev : [...prev, image]));
  };

  const remove = (id: string): void => {
    setAttached((prev) => prev.filter((row) => row.id !== id));
  };

  const takeAll = (): StoredImage[] => {
    const staged = attached;
    setAttached([]);
    return staged;
  };

  const restore = (images: StoredImage[]): void => {
    setAttached(images);
  };

  const addFile = async (file: File): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      add(await saveUploadedImage({ bytes, mimeType: file.type, fileName: file.name }));
    } catch (uploadFailure: unknown) {
      setError(errorMessage(uploadFailure));
      toastError('Could not attach that image', uploadFailure);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (attachRequest === undefined) return;
    let cancelled = false;
    // The image is an ordinary gallery row, so staging it is a Dexie read —
    // NO copy, NO re-upload and NO request (docs/17 row 18).
    getImage(attachRequest.imageId)
      .then(
        (image) => {
          if (cancelled) return;
          if (image === undefined) {
            // The row is gone: say so rather than stage nothing silently (rule
            // 1). The request is still consumed below — it is not retried.
            setError('That gallery image is no longer available to attach.');
            return;
          }
          add(image);
        },
        (loadFailure: unknown) => {
          if (cancelled) return;
          setError(errorMessage(loadFailure));
          toastError('Could not attach that image', loadFailure);
        },
      )
      .finally(() => {
        // CONSUMED once, whatever happened: `App` clears the request, so
        // re-mounting this tab can never re-attach a stale one.
        if (!cancelled) onAttachConsumed(attachRequest.nonce);
      });
    return () => {
      cancelled = true;
    };
  }, [attachRequest, onAttachConsumed]);

  return { attached, add, addFile, remove, takeAll, restore, busy, error };
}
