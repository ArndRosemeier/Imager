import { toast } from 'sonner';

import { errorMessage } from '@/lib/errors';

/**
 * THE toast seam (rule 2): every user-visible notice goes through here,
 * never through ad-hoc `sonner` calls in features. Errors stay until
 * dismissed and carry a close button.
 */
export function toastError(title: string, error?: unknown): void {
  toast.error(title, {
    ...(error === undefined ? {} : { description: errorMessage(error) }),
    duration: Infinity,
    closeButton: true,
  });
}

export function toastSuccess(title: string, description?: string): void {
  toast.success(title, description === undefined ? {} : { description });
}
