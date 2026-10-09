import type { StoredImage } from '@/domain/image';
import { useObjectUrl } from '@/lib/useObjectUrl';

/** Object URL for a stored image, revoked on change/unmount (no leak). */
export function useImageUrl(image: StoredImage): string | null {
  return useObjectUrl(image.bytes, image.mimeType);
}
