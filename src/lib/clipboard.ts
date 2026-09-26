/**
 * THE clipboard seam: the ONE place Imager puts text on the owner's clipboard.
 *
 * A prompt is the most reusable thing this app produces (the owner re-runs and
 * edits prompts elsewhere), so "get this exact text out" is a real workflow and
 * it gets exactly one mechanism.
 *
 * WHY A LOUD THROW INSTEAD OF A LEGACY FALLBACK (the decided, pinned choice):
 * the obvious fallback is `document.execCommand('copy')` over a temporary
 * `<textarea>`. It is rejected here because it is (a) deprecated and removable
 * at any time, (b) a SECOND copy mechanism — the opposite of rule 4, and one
 * that would take a live text selection to work, (c) unreliable in exactly the
 * situations where `navigator.clipboard` is missing (an insecure context or a
 * sandboxed frame), and (d) the kind of path that quietly does nothing. A
 * failed copy MUST be visible: a silent no-op would tell the owner his prompt is
 * on the clipboard when it is not (rule 1). So the API's absence and any
 * rejection it produces both propagate with their real reason, and the one
 * caller (`CopyButton`) surfaces them through the toast seam (rule 2).
 *
 * `navigator.clipboard` needs a SECURE CONTEXT. Imager is served over https and
 * on localhost, so it is present in every supported deployment — the guard is
 * for the honest edge, not for a guess about the common case.
 */
/**
 * The one method this seam needs, read STRUCTURALLY. `lib.dom` declares
 * `navigator.clipboard` as unconditionally present, so the runtime check has to
 * go through a widened view: the API needs a SECURE CONTEXT, and an old browser
 * or a sandboxed frame may simply not have it. Asserting the widened type (not
 * annotating a `Clipboard | undefined` local) is what stops the compiler from
 * narrowing the check away as dead code.
 */
type ClipboardWriter = { writeText?: (text: string) => Promise<void> } | undefined;

export async function copyText(text: string): Promise<void> {
  const clipboard = navigator.clipboard as ClipboardWriter;
  if (clipboard?.writeText === undefined) {
    throw new Error(
      'The clipboard API is unavailable in this browser context (it requires a secure https:// page or localhost) — nothing was copied.',
    );
  }
  // No catch: a rejected write (permission denied, document not focused) keeps
  // its own DOMException, so the owner is told the REAL reason.
  await clipboard.writeText(text);
}
