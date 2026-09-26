/**
 * Image TAGS (docs/17 row 34): the ONE place a tag string is normalized, the
 * ONE place the tag list is DERIVED from the images, and the ONE pure filter
 * that turns a selection into the set of images the gallery shows.
 *
 * NO SECOND SOURCE OF TRUTH: there is no `tags` table, no managed tag list and
 * no index — a tag exists exactly as long as at least one image carries it, and
 * the bar's list is recomputed from the loaded rows (`tagCounts`, called by the
 * gallery from the rows it already read). A tag that no image carries therefore
 * disappears on its own; deleting a tag from its last image deletes the tag.
 * (Pin: tests/architecture/one-tag-source.test.ts — no `tags` store in
 * `src/db/db.ts`, and `tagCounts` defined in exactly one module with exactly
 * one caller.)
 *
 * The filter is a PURE function over inputs (rows in, rows out) so the AND/OR
 * toggle is pinned without a DOM, and it returns the input ORDER untouched:
 * `listImages` is the ONE ordering seam (favourites first, newest-first inside
 * each group, docs/17 row 32), and filtering must never become a second one.
 */

/** The longest tag this app stores, counted after normalization. */
export const TAG_MAX_CHARS = 40;

/**
 * A tag as the app stores it: trimmed, internal whitespace runs collapsed to
 * one space, lowercased, capped at `TAG_MAX_CHARS`.
 *
 * WHY LOWERCASE: the owner's stated worry is near-duplicate tags — "so 'orc'
 * and 'Orcs' do not both appear". Lowercasing makes `Orc`, `ORC` and `orc` the
 * SAME stored string, so that near-duplicate cannot exist at all rather than
 * being merely compared case-insensitively in one place and forgotten in
 * another. `Orcs` (an inflection, not a case difference) is a different string
 * and is deliberately NOT merged — renaming/merging tags is out of this slice —
 * but the suggestion list offers the existing `orc` the moment the owner types
 * `Or`, so the two spellings cannot be created by accident.
 *
 * The whitespace pattern is an OUTPUT ENCODER, not a parser (AGENTS rule 5):
 * a tag is a STRUCTURED field the app itself defines, and this maps arbitrary
 * text onto the character contract a tag has. It reads no meaning out of free
 * text — the same contract `sanitizeFileName` has in the export seam.
 */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, TAG_MAX_CHARS);
}

/**
 * The stored form of a whole tag list: each tag normalized, empties dropped,
 * duplicates (after normalization) collapsed, and the result SORTED so the
 * canonical form of a set of tags does not depend on the order they were typed
 * in. `[]` is the meaning a row written before tags existed already had — the
 * app simply had no tags for it (docs/17 row 34).
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of raw) {
    const normalized = normalizeTag(tag);
    if (normalized !== '') seen.add(normalized);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** One tag in use, with how many images carry it. */
export interface TagCount {
  tag: string;
  count: number;
}

/**
 * The tag list, DERIVED from the images — the only place it is computed. Each
 * image counts ONCE per tag (a row with a duplicated tag is still one image),
 * and the result is alphabetical so the bar cannot reshuffle between renders.
 */
export function tagCounts(images: readonly { tags: readonly string[] }[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const image of images) {
    for (const tag of new Set(image.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * How a multi-tag selection is matched (the owner's explicit choice: a toggle).
 * `AND` narrows — an image must carry EVERY selected tag; `OR` widens — any one
 * of them is enough. The LABEL is the value, because the shared `Segmented`
 * control renders its options directly and the owner asked for AND/OR.
 */
export const TAG_MATCH_MODES = ['AND', 'OR'] as const;
export type TagMatchMode = (typeof TAG_MATCH_MODES)[number];

/**
 * The images for a selection, in the ORDER they came in. No selection means
 * everything (an empty AND would be technically "all" but reads as a filter
 * that hides the library, so it is stated instead of derived).
 */
export function filterImages<T extends { tags: readonly string[] }>(
  images: readonly T[],
  selected: readonly string[],
  mode: TagMatchMode,
): T[] {
  if (selected.length === 0) return images.slice();
  return images.filter((image) =>
    mode === 'AND'
      ? selected.every((tag) => image.tags.includes(tag))
      : selected.some((tag) => image.tags.includes(tag)),
  );
}
