import { useEffect, useState } from 'react';

import { imageBlob, type StoredImage } from '@/domain/image';

/** Object URL for a stored image, revoked on change/unmount (no leak). */
export function useImageUrl(image: StoredImage): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(imageBlob(image));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [image]);
  return url;
}
