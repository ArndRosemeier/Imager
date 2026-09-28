/**
 * THE image viewer's "Add to store" control (docs/17 row 48).
 *
 * The owner's ask, verbatim: *"There should also be a button in the image
 * viewer to just add this to the store if its not already there, for
 * convenience."* This is that button, and it follows the lightbox's EXISTING
 * optional-callback discipline (`onRefine`, `onChat`): the viewer renders it only
 * when a host hands it the capability (`storePush`), never as an invented
 * affordance.
 *
 * THREE THINGS IT MUST NEVER DO:
 *  * offer a duplicate: when the picture is already in the store the control is
 *    DISABLED and says where it landed (or that it is in a folder it cannot
 *    show), because "if it's not already there" is the owner's own clause;
 *  * guess: `cannot-tell` and a missing key are disabled states with a reason,
 *    never a button that quietly does nothing;
 *  * double-push: it is busy for the whole round trip, so a second click cannot
 *    start a second upload of the same picture.
 *
 * Everything store-specific lives in `storePush.ts` (the seam); this file is
 * presentation and the two pieces of state the button owns (its answer and its
 * busy flag).
 */
import { useEffect, useId, useState } from 'react';

import { buttonClass } from '@/components/styles';
import type { StoredImage } from '@/domain/image';
import { errorMessage } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';
import { DEFAULT_STORE_QUALITY, storeEncodingDescription } from '@/server/store-encode';
import type { StorePushApi, StorePushAvailability } from '@/features/store/storePush';

/** What the button knows: still checking, or what the seam answered. */
type PushState = StorePushAvailability | { status: 'checking' };

/**
 * The reason the action cannot run, in one sentence the owner can act on, or
 * `null` when it can. Every arm is named — a disabled control with no stated
 * reason is the failure mode this function exists to prevent.
 */
function pushBlockedReason(state: PushState): string | null {
  switch (state.status) {
    case 'checking':
      return 'Checking whether this image is already in the store…';
    case 'unconfigured':
      return 'No ServerStore key yet. Add one on the Store tab — the rest of Imager works without it.';
    case 'unreachable':
      return `The store could not be reached or refused this key: ${errorMessage(state.error)}. Nothing was uploaded.`;
    case 'no-folder':
      return `No folder record in the store owns this key yet. The name the app proposes for it is "${state.defaultFolderSlug}" — create that folder on the Store tab first.`;
    case 'already':
      return state.visible
        ? `Already in the store as ${state.objectName}. Nothing was uploaded.`
        : `Already in the store as ${state.objectName}, in a folder that is not visible to you. Nothing was uploaded.`;
    case 'cannot-tell':
      return state.reason;
    case 'ready':
      return null;
  }
}

/** The button's own label: the answer is in the label, not only in the tooltip. */
function pushLabel(state: PushState, busy: boolean): string {
  if (busy) return 'Adding…';
  switch (state.status) {
    case 'checking':
      return 'Checking the store…';
    case 'already':
      return `Already in ${state.folderLabel}`;
    default:
      return 'Add to store';
  }
}

export function StorePushButton({
  image,
  storePush,
}: Readonly<{
  image: StoredImage;
  /** The host's store-push capability (the real one is `storePushApi`). */
  storePush: StorePushApi;
}>): React.JSX.Element {
  const [state, setState] = useState<PushState>({ status: 'checking' });
  const [busy, setBusy] = useState(false);
  const reasonId = useId();

  /**
   * The check runs ONCE per opened image. The effect depends on the image and
   * the host capability ONLY — never on the state it sets — so a re-render can
   * never re-arm it (the slice-42 rebuild livelock was exactly a counter-keyed
   * effect chasing its own refresh).
   */
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'checking' });
    storePush.inspect(image).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'unreachable', error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [image, storePush]);

  const push = (): void => {
    // `busy` is the whole guard: a second click during the round trip returns
    // here and does nothing, so one picture cannot become two objects.
    if (state.status !== 'ready' || busy) return;
    const ready = state;
    setBusy(true);
    storePush
      .push(image, ready)
      .then(
        (result) => {
          toastSuccess(
            `Added to ${result.folderLabel}`,
            `${result.objectName} — ${storeEncodingDescription(DEFAULT_STORE_QUALITY)}`,
          );
          /*
           * The picture IS in that folder now — by construction, from the push
           * that just returned — so the button becomes its "already there"
           * state without a second store round trip. The folder is the owner's
           * own, which is always visible to him, so `visible` is true.
           */
          setState({
            status: 'already',
            objectName: result.objectName,
            folderLabel: result.folderLabel,
            visible: true,
          });
        },
        (error: unknown) => {
          toastError('Could not add this image to the store', error);
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const reason = pushBlockedReason(state);
  const canPush = state.status === 'ready' && !busy;
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        className={buttonClass('invert')}
        disabled={!canPush}
        aria-describedby={reason === null ? undefined : reasonId}
        title={
          state.status === 'ready'
            ? `Push this image into ${state.folderLabel} — ${storeEncodingDescription(DEFAULT_STORE_QUALITY)}`
            : undefined
        }
        onClick={push}
      >
        {pushLabel(state, busy)}
      </button>
      {reason !== null && (
        <span id={reasonId} role="status" className="max-w-md text-caption opacity-80">
          {reason}
        </span>
      )}
    </span>
  );
}
