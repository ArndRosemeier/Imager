import { useEffect, useState } from 'react';

import { toastError } from '@/lib/toast';
import { serveThumbnail } from '@/server/store-cache';
import type { StoreConnection } from '@/server/store-session';

/** What one thumbnail read produced, so the caller can render all three states
 * honestly instead of an empty box. */
export interface StoreThumbnailState {
  /** An object URL for the derived thumbnail, or `null` while it is not ready. */
  url: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * ONE store image's browser thumbnail, through the cache seam.
 *
 * The hash is part of the identity: when the listing reports a different
 * `sha256`, the cached thumbnail is invalid and this hook refetches the FULL
 * image and re-derives the thumbnail from it (docs/17 row 42). That is the
 * whole point of passing `sha256` here instead of just the object name.
 *
 * The picture's own MIME type and size are read from the object's header by
 * the cache seam, so this hook needs the name and the listing's hash only.
 */
export function useStoreThumbnail(
  connection: StoreConnection,
  image: { name: string; sha256: string },
): StoreThumbnailState {
  const [state, setState] = useState<StoreThumbnailState>({ url: null, loading: true, error: null });

  const { name, sha256 } = image;
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setState({ url: null, loading: true, error: null });
    serveThumbnail(connection.target, name, { sha256 }).then(
      (thumbnail) => {
        if (cancelled) return;
        created = URL.createObjectURL(new Blob([thumbnail.bytes], { type: thumbnail.mimeType }));
        setState({ url: created, loading: false, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          url: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [connection, name, sha256]);

  return state;
}

/**
 * The ONE place a store-image failure reaches the user. A thumbnail that cannot
 * be derived is reported through the app's error surface (rule 2) — a silent
 * grey box would tell the owner the picture is gone when the network merely
 * failed.
 */
export function useReportThumbnailError(name: string, error: Error | null): void {
  useEffect(() => {
    if (error === null) return;
    toastError(`Could not load stored image ${name}`, error);
  }, [name, error]);
}
