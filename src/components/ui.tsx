/**
 * The shared UI blocks: the segmented switch, the empty-state surface and the
 * copy control. Their styling comes from `styles.ts` and the theme seam's
 * stylesheet; nothing here invents a colour or a font size of its own.
 */

import { useEffect, useState } from 'react';

import { buttonClass, focusRing, type ButtonVariant } from '@/components/styles';
import { copyText } from '@/lib/clipboard';
import { saveFile, type SaveRequest } from '@/lib/saveFile';
import { toastError, toastSuccess } from '@/lib/toast';

/** How long the button's own label confirms a successful copy. */
const COPIED_FEEDBACK_MS = 2000;

/** A quiet, honest presentation for a genuinely empty surface (rule 1). */
export function EmptyState({
  title,
  hint,
}: Readonly<{ title: string; hint?: string }>): React.JSX.Element {
  return (
    <div className="card flex flex-col items-center gap-1 px-6 py-10 text-center">
      <p className="text-heading text-ink">{title}</p>
      {hint !== undefined && <p className="max-w-md text-body text-muted">{hint}</p>}
    </div>
  );
}

/**
 * THE app's copy control: one click puts `text` on the clipboard through the
 * `copyText` seam.
 *
 * FEEDBACK (the decided choice): success is announced on the button ITSELF —
 * its visible label flips to "Copied" and its accessible name to "Copied to the
 * clipboard" — because the confirmation belongs where the owner is looking, and
 * a grid of tiles must not fire one notice per copy. A FAILURE goes to the
 * app's error surface (`toastError`, rule 2) and the label does NOT change: this
 * control never claims a copy that did not happen (rule 1). Recovery of the
 * idle label is safe — the effect clears its timer on unmount, so a tile that
 * scrolls away cannot set state afterwards.
 *
 * `text` is always the EXACT string. A caller may DISPLAY a shorter form (the
 * tile's caption is two clamped lines); what lands on the clipboard is never the
 * display form.
 */
export function CopyButton({
  text,
  label,
  variant = 'secondary',
  className = '',
}: Readonly<{
  /** The exact text to copy — never a truncated display form. */
  text: string;
  /** The accessible name of the control while it is idle. */
  label: string;
  /** The button role, so this control sits in the design system like any other. */
  variant?: ButtonVariant;
  /** Extra role-appropriate classes (compactness), never a raw colour. */
  className?: string;
}>): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied to the clipboard' : label}
      className={buttonClass(variant, className)}
      onClick={() => {
        copyText(text).then(
          () => {
            setCopied(true);
          },
          (error: unknown) => {
            toastError('Could not copy to the clipboard', error);
          },
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * THE app's save control: one click puts bytes on the owner's disk through the
 * `saveFile` seam (the file picker where the browser has one, an anchor
 * download otherwise).
 *
 * FEEDBACK (the decided choice): a SAVE is confirmed through the app's one
 * notice surface — a download is otherwise easy to miss, and the anchor branch
 * has no dialog to close. A CANCEL is deliberately silent: the seam reports it
 * as the `cancelled` outcome and this control does nothing with it, because
 * "the owner changed his mind" is not an error (rule 1: never claim a save that
 * did not happen, and never invent a failure that did not happen either). A
 * real failure keeps its own reason and goes to `toastError` (rule 2).
 *
 * `buildRequest` is called INSIDE the click handler, not during render: the
 * request must be built from the state of the world at click time (a fresh
 * timestamp, fresh rows), and the picker it opens needs that click's transient
 * activation.
 */
export function SaveButton({
  label,
  buildRequest,
  variant = 'secondary',
  className = '',
  disabled = false,
}: Readonly<{
  /** The control's label while it is idle. */
  label: string;
  /** Builds the save request at click time. */
  buildRequest: () => SaveRequest;
  /** The button role, so this control sits in the design system like any other. */
  variant?: ButtonVariant;
  /** Extra role-appropriate classes, never a raw colour. */
  className?: string;
  /** Refuse the action with a reason stated by the caller's own copy. */
  disabled?: boolean;
}>): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || saving}
      className={buttonClass(variant, className)}
      onClick={() => {
        const request = buildRequest();
        setSaving(true);
        saveFile(request)
          .then(
            (outcome) => {
              if (outcome.status === 'saved') toastSuccess(`Saved ${request.fileName}`);
            },
            (error: unknown) => {
              toastError(`Could not save ${request.fileName}`, error);
            },
          )
          .finally(() => {
            setSaving(false);
          });
      }}
    >
      {saving ? 'Saving…' : label}
    </button>
  );
}

/** A labelled switch between a small set of exclusive choices. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: Readonly<{
  label: string;
  options: readonly T[];
  value: T;
  onChange: (option: T) => void;
}>): React.JSX.Element {
  return (
    <div role="tablist" aria-label={label} className="seg-group">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={value === option}
          className={`seg-item ${focusRing} ${
            value === option ? 'seg-item-active' : 'hover:seg-item-hover'
          }`}
          onClick={() => {
            onChange(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
