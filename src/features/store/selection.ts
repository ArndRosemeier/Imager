/**
 * THE store's multiselect gesture (docs/17 rows 42 and 44).
 *
 * ONE function, because there are now TWO panes that select store-bound images
 * with the same gestures: the store's own image pane (`FolderDialog`, over
 * objects already in the store) and the library picker (`LibraryPush`, over the
 * LOCAL gallery). Two inline copies of "click / ctrl-cmd-click / shift-range"
 * would drift — the shift range in particular has to walk the VISIBLE order, so
 * a pane that filtered its grid differently would select a different set with
 * the same click.
 *
 * It is PURE and it returns the next state rather than writing component state,
 * so both panes stay the owners of their own selection and the gesture itself
 * has one definition (pin: `tests/architecture/one-store-source.test.ts`).
 */

/** The modifier keys of one click, exactly as a React mouse event carries them. */
export interface SelectionEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** The selection and the anchor a range extends from. */
export interface SelectionState {
  selected: string[];
  anchor: string | null;
}

/**
 * The next selection for one click on `name`.
 *
 *  * plain click      → that one image
 *  * ctrl / cmd click → toggle that one, keeping the rest
 *  * shift click      → the range from the ANCHOR to this one, in the order the
 *                       caller currently shows (`order`), so a filtered grid
 *                       ranges over what is on screen;
 *
 * `order` must be the VISIBLE order (what the pane is rendering), never the whole
 * list: a range across hidden rows would select pictures the owner cannot see.
 * A shift-click with no anchor — or one whose anchor or target is not in the
 * visible order — falls through to the ctrl behaviour, which is the honest
 * reading of "I hold shift but there is no range to draw"; the anchor does NOT
 * move on a shift-click, so a second shift-click extends from the same place.
 */
export function nextSelection(
  current: readonly string[],
  anchor: string | null,
  order: readonly string[],
  name: string,
  event: SelectionEvent,
): SelectionState {
  if (event.shiftKey && anchor !== null) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(name);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      return { selected: order.slice(start, end + 1), anchor };
    }
  }
  if (event.ctrlKey || event.metaKey) {
    return {
      selected: current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name],
      anchor: name,
    };
  }
  return { selected: [name], anchor: name };
}
