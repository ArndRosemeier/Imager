import { useEffect, useState } from 'react';

/**
 * THE object-URL hook: an object URL for in-memory bytes, revoked on change and
 * unmount (no leak). The gallery's `useImageUrl` and the Music tab's player
 * both go through it, so there is one place a blob URL's lifetime is decided.
 */
export function useObjectUrl(bytes: Uint8Array<ArrayBuffer>, mimeType: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [bytes, mimeType]);
  return url;
}
