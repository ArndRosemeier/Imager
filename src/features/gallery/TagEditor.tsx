/**
 * The TAG EDITOR (docs/17 row 34): free typing with suggestions drawn from the
 * tags already in use, on the image the owner has open.
 *
 * WHERE IT LIVES, AND WHY HERE: the lightbox is the app's detail surface — the
 * one place an image's metadata (prompt, model, size, run cost, save, refine,
 * chat, delete) is read and acted on. The tile is deliberately the artwork
 * (three sibling controls already); a fourth would compete with the picture, and
 * surfacing every tile's tags there is not what was asked. Editing is therefore
 * ONE control, in ONE place, and the tag BAR is the filter surface, never a
 * second editor.
 *
 * The component owns only the DRAFT (the scratch text) and the pending flag. The
 * tags it renders come from the caller's freshly re-read stored row, so a failed
 * write can never leave a tag on screen that is not in the database (rule 1) —
 * and a rejected write goes to the app's ONE error surface.
 *
 * NORMALIZATION IS NOT DONE HERE: `normalizeTag` is used to decide whether the
 * draft is addable (so "Orc" and "orc" are visibly the same tag), and the WRITE
 * seam (`setImageTags`) applies the canonical form. One rule, one authority.
 */
import { useState } from 'react';

import { buttonClass, focusRing } from '@/components/styles';
import { normalizeTag, TAG_MAX_CHARS } from '@/domain/tags';
import { toastError } from '@/lib/toast';

/** How many existing tags are offered at once — a hint, not a menu. */
const MAX_SUGGESTIONS = 8;

export function TagEditor({
  tags,
  suggestions,
  onChange,
}: Readonly<{
  /** The STORED tags of this image, in their canonical form. */
  tags: readonly string[];
  /** Every tag already in use elsewhere, for the suggestion list. */
  suggestions: readonly string[];
  /** Performs the write; rejects with the real reason on failure. */
  onChange: (next: string[]) => Promise<void>;
}>): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);

  const normalizedDraft = normalizeTag(draft);
  // Adding a tag that is already on this image is a no-op, so the control is
  // disabled rather than silently doing nothing (rule 1: no invisible action).
  const canAdd = normalizedDraft !== '' && !tags.includes(normalizedDraft);
  const offered = suggestions
    .filter((tag) => !tags.includes(tag) && (normalizedDraft === '' || tag.includes(normalizedDraft)))
    .slice(0, MAX_SUGGESTIONS);

  const commit = (next: string[]): void => {
    if (pending) return;
    setPending(true);
    // The DRAFT is scratch text, so clearing it is honest even before the write
    // settles; the CHIPS are the caller's stored row and never move on hope.
    setDraft('');
    onChange(next)
      .catch((error: unknown) => {
        toastError('Could not update the tags', error);
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label opacity-80">Tags</span>
        {tags.length === 0 && <span className="text-caption opacity-80">No tags yet</span>}
        {tags.map((tag) => (
          <span key={tag} className="chip">
            <span>{tag}</span>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              disabled={pending}
              className={`${focusRing} disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => {
                commit(tags.filter((current) => current !== tag));
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`field field-auto ${focusRing}`}
          aria-label="New tag"
          placeholder="orc"
          maxLength={TAG_MAX_CHARS}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !canAdd) return;
            event.preventDefault();
            commit([...tags, normalizedDraft]);
          }}
        />
        <button
          type="button"
          disabled={!canAdd || pending}
          className={buttonClass('invert')}
          onClick={() => {
            commit([...tags, normalizedDraft]);
          }}
        >
          Add tag
        </button>
      </div>
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption opacity-80">In use</span>
          {offered.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-label={`Add tag ${tag}`}
              disabled={pending}
              className={`chip ${focusRing} hover:seg-item-hover disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => {
                commit([...tags, tag]);
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
