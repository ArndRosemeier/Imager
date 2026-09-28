import { focusRing } from '@/components/styles';
import type { StoreImageRef } from '@/features/store/FolderDialog';
import { useReportThumbnailError, useStoreThumbnail } from '@/features/store/useStoreThumbnail';
import type { StoreConnection } from '@/server/store-session';

/**
 * One tile in the store's image pane.
 *
 * The picture shown is a THUMBNAIL DERIVED FROM THE FULL IMAGE the store holds
 * (docs/17 row 42) — the store never archives a reduced copy. The tile is a
 * plain button (no nested controls, unlike the gallery's tile) so multiselect
 * is one unambiguous gesture: click, ctrl/cmd-click, shift-range. The caption
 * shows the OBJECT NAME: it is the stable identity, and the picture's own
 * prompt requires opening the object (the index carries tags, not prose).
 */
export function StoreImageTile({
  connection,
  image,
  selected,
  onSelect,
}: Readonly<{
  connection: StoreConnection;
  image: StoreImageRef;
  selected: boolean;
  onSelect: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
}>): React.JSX.Element {
  const thumbnail = useStoreThumbnail(connection, image);
  useReportThumbnailError(image.name, thumbnail.error);
  return (
    <div
      className={`relative aspect-square w-full overflow-hidden rounded-lg ${
        selected ? 'ring-2 ring-accent' : ''
      }`}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? 'Selected' : 'Select'} stored image ${image.name}`}
        className={`group relative block h-full w-full bg-subtle ${focusRing}`}
        onClick={(event) => {
          onSelect({ ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey });
        }}
      >
        {thumbnail.url !== null ? (
          <img
            src={thumbnail.url}
            alt={image.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-caption text-muted">
            {thumbnail.error !== null ? 'failed' : 'loading…'}
          </span>
        )}
        <span className="tile-caption group-hover:opacity-100 group-focus-within:opacity-100">
          <span className="line-clamp-2 min-w-0 text-left font-mono">{image.name}</span>
        </span>
        {selected && (
          <span className="absolute top-1 left-1 rounded-full bg-accent px-1 text-caption text-on-accent">
            ✓
          </span>
        )}
      </button>
    </div>
  );
}
