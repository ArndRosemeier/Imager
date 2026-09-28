import { useState } from 'react';

import { buttonClass } from '@/components/styles';
import { Segmented } from '@/components/ui';
import { filterImages, tagCounts, type TagMatchMode } from '@/domain/tags';
import { TagBar } from '@/features/gallery/TagBar';
import { LibraryPushControl } from '@/features/store/LibraryPush';
import { nextSelection } from '@/features/store/selection';
import { StoreImageTile } from '@/features/store/StoreImageTile';
import {
  uploadFiles,
  type DownloadTarget,
  type UploadProgress,
} from '@/features/store/storeTransfer';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  DEFAULT_STORE_QUALITY,
  STORE_QUALITIES,
  storeEncodingDescription,
  type StoreQuality,
} from '@/server/store-encode';
import type { StoreConnection } from '@/server/store-session';
import {
  createFolder,
  setFolderPrivate,
  type Directory,
  type FolderOwnership,
} from '@/server/store-folders';
import { slugFromLabel } from '@/server/store-files';

/**
 * THE FOLDER DIALOG (docs/17 row 42): a Windows-Explorer-like browser over the
 * one shared store, with NO subfolders.
 *
 *  * LEFT — the folder pane: YOUR folder first, then the others' public ones.
 *    The owner's answer is the whole design here: *"Each user starts in his
 *    folder, but can get a view of all public folders."* The scope switch is
 *    that second half, made explicit.
 *  * RIGHT — the image pane: thumbnails derived from the FULL image the store
 *    holds, the tag filter bar above them (the SAME `TagBar` the gallery uses,
 *    over the same `tagCounts`/`filterImages` seam), and multiselect with a
 *    visible count.
 *  * BOTTOM — TWO sibling upload actions, both visible: `Add from gallery…`
 *    pushes images the owner already has in Imager's LOCAL library (docs/17 row
 *    44), and `Upload images…` takes files from this device (docs/17 row 42).
 *    They are two entry points into ONE uploader (`uploadStoredImages` /
 *    `uploadFiles` → `uploadSources`), so the encoder, the object model and the
 *    index update cannot drift; each reports per-file progress and per-file
 *    errors that never abort the batch. Download (one image as itself, a
 *    multi-selection as ONE zip) sits beside them.
 *
 * THE DESTINATION RULE (docs/17 row 45): a LIBRARY push goes into the folder
 * currently open in the folder pane, defaulting to your own folder, and the
 * dialog says so on screen. Pushing into another key's folder is ALLOWED — the
 * store has no per-object permissions and every key writes the whole store — so
 * the dialog states that too rather than hiding the fact. The DEVICE picker is
 * unchanged: it still uploads into your own folder, exactly as it always did.
 *
 * PRIVACY IS STATED, NOT IMPLIED: the folder card carries the owner's own
 * framing — the flag is honoured by THIS APP and is not enforced by the server.
 */
export interface StoreImageRef {
  name: string;
  sha256: string;
  size: number;
  tags: string[];
  createdAt: string;
  /** The picture's own MIME type, from the object header via the index. */
  mimeType: string;
  folderSlug: string;
}

/** One folder plus what the app derived for it. */
export interface StoreFolderView {
  slug: string;
  displayName: string;
  owner: string;
  private: boolean;
  /**
   * Whose folder this is, decided by the record's `owner` — the key ID — and
   * never by a slug (docs/17 row 50). Three-valued on purpose: `unknown` is a
   * folder whose record names no owner, and the dialog must say so rather than
   * pick a side.
   */
  ownership: FolderOwnership;
  /** True when the folder's index was absent or unreadable: rebuild, loudly. */
  missingIndex: boolean;
  /** How many image objects the LISTING reports for this folder (an index-less
   * folder is never presented as empty: this is the number the dialog shows). */
  indexImageCount: number;
  images: StoreImageRef[];
}

const SCOPES = ['My folder', 'All public folders'] as const;
type Scope = (typeof SCOPES)[number];

function imageKey(image: StoreImageRef): string {
  return image.name;
}

/**
 * How one folder's ownership reads in the destination line. THREE-VALUED on
 * purpose (docs/17 row 50): "cannot tell" is a real answer and must not be
 * flattened into either "yours" or "another key's".
 */
function describeOwnership(folder: StoreFolderView): string {
  switch (folder.ownership) {
    case 'mine':
      return `${folder.displayName} — yours`;
    case 'other':
      return `${folder.displayName} — ANOTHER key’s folder`;
    case 'unknown':
      return `${folder.displayName} — its record names no owner`;
  }
}

export function FolderDialog({
  connection,
  directory,
  view,
  indexMissing = false,
  indexImageCount = 0,
  rebuilding = false,
  onRebuildIndex,
  onRefresh,
  onDownload,
  onUploaded,
}: Readonly<{
  connection: StoreConnection;
  directory: Directory;
  view: StoreFolderView[];
  /**
   * True when the folder on screen has no readable index right now. The
   * DIALOG does not rebuild it itself (a WRITE triggered from a render effect
   * can loop); it says so — with the number of images the listing found — and
   * offers the rebuild, while `StoreArea` also rebuilds it automatically ONCE
   * per refresh.
   */
  indexMissing?: boolean | undefined;
  /**
   * How many image objects the LISTING reports for the folder `indexMissing`
   * is about (an index-less folder is never presented as empty: this is the
   * number the message names). It belongs to the OPEN folder, so the dialog
   * takes it from the host rather than assuming it is "mine".
   */
  indexImageCount?: number | undefined;
  rebuilding?: boolean | undefined;
  onRebuildIndex?: (() => void) | undefined;
  onRefresh: () => void;
  onDownload: (selections: readonly DownloadTarget[]) => void;
  onUploaded: () => void;
}>): React.JSX.Element {
  const [scope, setScope] = useState<Scope>('My folder');
  /*
   * The dialog opens on the folder this IDENTITY owns when the store has one
   * (docs/17 row 50: the record whose `owner` is this key's id), else on the
   * NAME the app proposes — which is only a proposal until such a record
   * exists. Deciding this from the slug was the owner's report: his own folder
   * `test` was not opened, because his key's label slugified to something else.
   */
  const [openSlug, setOpenSlug] = useState<string | null>(
    () => view.find((folder) => folder.ownership === 'mine')?.slug ?? connection.defaultFolderSlug,
  );
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<TagMatchMode>('AND');
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [creating, setCreating] = useState(false);
  /**
   * The quality the NEXT upload is encoded at (the owner's ask: "hardly
   * noticeable" is his eye, so it is adjustable without a code change). It is
   * per upload, not global state: changing it never re-encodes anything already
   * in the store.
   */
  const [quality, setQuality] = useState<StoreQuality>(DEFAULT_STORE_QUALITY);

  const mine = view.find((folder) => folder.ownership === 'mine');
  const others = view.filter((folder) => folder.ownership !== 'mine');

  // The folders in scope: "My folder" is exactly yours; "All public folders" is
  // everyone's non-private ones PLUS your own (your work stays visible to you
  // even when you flagged it private — the flag hides it from OTHERS).
  const inScope = scope === 'My folder' ? view.filter((folder) => folder.ownership === 'mine') : view;

  const flatImages = inScope.flatMap((folder) => folder.images);
  const derivedTags = tagCounts(flatImages);
  const visibleImages = filterImages(flatImages, selectedTags, matchMode);

  /*
   * The folder a LIBRARY push targets: the one currently open in the folder
   * pane, defaulting to your own (docs/17 row 45). The device picker keeps its
   * original destination — your own folder — and the actions area names both, so
   * neither is a surprise. The folder "open in the pane" is also what the
   * missing-index message below counts, so the number and the message agree.
   */
  const destination = view.find((folder) => folder.slug === openSlug) ?? mine;
  const destinationSlug = destination?.slug ?? null;

  function toggleSelect(name: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
    /*
     * THE gesture is ONE function (`nextSelection`): the store's image pane and
     * the library picker select with the same click / ctrl-cmd-click /
     * shift-range, over each pane's own VISIBLE order.
     */
    const next = nextSelection(
      selected,
      anchor,
      visibleImages.map(imageKey),
      name,
      event,
    );
    setSelected(next.selected);
    setAnchor(next.anchor);
  }

  const onUpload = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    const target = mine?.slug ?? connection.defaultFolderSlug;
    setBusy(true);
    setProgress([]);
    uploadFiles(
      connection,
      target,
      [...files],
      selectedTags,
      (entry) => {
        setProgress((current) => [
          ...current.filter((row) => row.key !== entry.key),
          entry,
        ]);
      },
      quality,
    )
      .then(
        (results) => {
          const failed = results.filter((row) => row.phase === 'failed').length;
          if (failed === 0)
            toastSuccess(
              `Uploaded ${String(results.length)} file${results.length === 1 ? '' : 's'}`,
              `into ${target} — encoded to WebP at ${quality} quality, same pixel size.`,
            );
          else toastError(`${String(failed)} of ${String(results.length)} files did not upload`, new Error(results.find((row) => row.phase === 'failed')?.error ?? ''));
          onUploaded();
        },
        (error: unknown) => {
          toastError('Could not upload into the store', error);
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const onDownloadClick = (): void => {
    const wanted = flatImages.filter((image) => selected.includes(imageKey(image)));
    if (wanted.length === 0) return;
    onDownload(
      wanted.map((image) => ({
        name: image.name,
        sha256: image.sha256,
        mimeType: image.mimeType,
      })),
    );
  };

  const onCreate = (): void => {
    const label = newFolder.trim();
    if (label === '') return;
    setBusy(true);
    let slug: string;
    try {
      slug = slugFromLabel(label, 'folder');
    } catch (error: unknown) {
      toastError('That folder name cannot be used', error);
      setBusy(false);
      return;
    }
    createFolder(
      connection.target,
      { slug, displayName: label, private: false, who: connection.who },
      view.map((folder) => folder.slug),
    )
      .then(
        () => {
          setNewFolder('');
          setCreating(false);
          toastSuccess(`Created folder "${label}"`, slug);
          setOpenSlug(slug);
          setScope('My folder');
          onUploaded();
        },
        (error: unknown) => {
          toastError('Could not create the folder', error);
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const onTogglePrivate = (slug: string, isPrivate: boolean): void => {
    const record = directory.folders.find((folder) => folder.record.slug === slug)?.record;
    if (record === undefined) return;
    setBusy(true);
    setFolderPrivate(connection.target, record, isPrivate)
      .then(
        () => {
          toastSuccess(isPrivate ? 'Folder is private' : 'Folder is public', 'Honoured by this app, not enforced by the server.');
          onUploaded();
        },
        (error: unknown) => {
          toastError('Could not change the folder privacy', error);
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-label="Folder browser" className="flex min-h-[32rem] flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Folders shown"
            options={SCOPES}
            value={scope}
            onChange={(next) => {
              setScope(next);
            }}
          />
          <span className="text-caption text-muted">
            {scope === 'My folder'
              ? mine === undefined
                ? `No folder record in the store names key ${connection.who.id} as its owner yet — the app proposes "${connection.defaultFolderSlug}". Create one below.`
                : `Your folder: ${mine.slug}`
              : `${String(others.filter((folder) => !folder.private).length)} public folder${others.filter((folder) => !folder.private).length === 1 ? '' : 's'} from other keys, plus yours`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass('secondary')}
            disabled={busy}
            onClick={() => {
              setCreating((value) => !value);
            }}
          >
            New folder
          </button>
          <button type="button" className={buttonClass('ghost')} onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>

      {creating && (
        <div className="card flex flex-wrap items-end gap-2 p-3">
          <div className="min-w-48 flex-1">
            <label htmlFor="new-folder" className="block text-label text-ink">
              New folder name
            </label>
            <input
              id="new-folder"
              className="field focus-visible:field-focus hover:field-hover mt-1"
              value={newFolder}
              onChange={(event) => {
                setNewFolder(event.target.value);
              }}
            />
          </div>
          <button type="button" className={buttonClass('primary')} disabled={busy} onClick={onCreate}>
            Create
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* ---------------------------------------------------- folder pane */}
        <nav aria-label="Store folders" className="card w-full shrink-0 overflow-y-auto p-2 lg:w-64">
          <p className="px-1 text-label text-muted">My folder</p>
          {mine === undefined ? (
            <p className="px-1 py-1 text-caption text-muted">
              No folder record in the store owns this key yet — create one.
            </p>
          ) : (
            <FolderRow
              folder={mine}
              open={openSlug === mine.slug}
              onOpen={() => {
                setScope('My folder');
                setOpenSlug(mine.slug);
              }}
              onTogglePrivate={(value) => {
                onTogglePrivate(mine.slug, value);
              }}
              onRebuild={onRebuildIndex}
              onMissingIndex={mine.missingIndex}
            />
          )}
          <p className="mt-3 px-1 text-label text-muted">Other folders visible to you</p>
          {others.length === 0 ? (
            <p className="px-1 py-1 text-caption text-muted">Nobody else has published one yet.</p>
          ) : (
            others.map((folder) => (
              <FolderRow
                key={folder.slug}
                folder={folder}
                open={openSlug === folder.slug}
                onOpen={() => {
                  setScope('All public folders');
                  setOpenSlug(folder.slug);
                }}
              />
            ))
          )}
        </nav>

        {/* ----------------------------------------------------- image pane */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <TagBar
            tags={derivedTags}
            selected={selectedTags}
            mode={matchMode}
            onToggle={(tag) => {
              setSelectedTags((current) =>
                current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag],
              );
            }}
            onModeChange={setMatchMode}
            onClear={() => {
              setSelectedTags([]);
            }}
          />
          <p className="text-caption text-muted">
            Showing {visibleImages.length} of {flatImages.length} stored images
          </p>
          {/*
            The selection count is its OWN element: it changes as the owner
            clicks, so it is also the live region that announces the change.
          */}
          <p className="text-caption text-muted" aria-live="polite">
            {selected.length === 0 ? 'no images selected' : `${String(selected.length)} selected`}
          </p>
          {indexMissing ? (
            <p className="card p-3 text-body text-muted" role="status">
              This folder&apos;s index could not be read, so the app is rebuilding it from the store
              listing and each image&apos;s own header — {String(indexImageCount)} image
              {indexImageCount === 1 ? '' : 's'} found in the store.{' '}
              {rebuilding ? 'Rebuilding…' : ''}{' '}
              {onRebuildIndex !== undefined && !rebuilding && (
                <button type="button" className={buttonClass('secondary')} onClick={onRebuildIndex}>
                  Rebuild now
                </button>
              )}
            </p>
          ) : flatImages.length === 0 ? (
            <p className="card p-3 text-body text-muted">
              This folder has no images yet. Use “Upload images…” below to add some — the store keeps
              them at full quality.
            </p>
          ) : visibleImages.length === 0 ? (
            <p className="card p-3 text-body text-muted">No stored image carries these tags.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
              {visibleImages.map((image) => (
                <StoreImageTile
                  key={image.name}
                  connection={connection}
                  image={image}
                  selected={selected.includes(imageKey(image))}
                  onSelect={(event) => {
                    toggleSelect(imageKey(image), event);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-strong pt-2">
        {/*
          The quality switch is the SAME `Segmented` control every other choice
          in the app uses, and the sentence beside it is the honest one: the
          store does NOT keep the uploaded file byte for byte, and the number in
          it is the quality actually selected (not always 90).
        */}
        <Segmented
          label="Upload quality"
          options={STORE_QUALITIES}
          value={quality}
          onChange={setQuality}
        />
        <span className="text-caption text-muted">{storeEncodingDescription(quality)}</span>
      </div>
      {/*
        WHERE a library push lands. The folder on screen is the default target
        (the owner's brief), falling back to his own folder; another key's folder
        is a legal target because the store has no per-object permissions, and
        the dialog says so instead of pretending otherwise. Ownership is read
        from the record's `owner` — the key ID — so the sentence below can never
        accuse the owner of his own folder (docs/17 row 50), and a record that
        names NO owner gets its own true sentence rather than a guess.
      */}
      <p className="text-caption text-muted">
        Library push destination:{' '}
        <span className="font-mono">{destinationSlug ?? '—'}</span>
        {destination === undefined ? '' : ` (${describeOwnership(destination)})`}
      </p>
      {destination?.ownership === 'other' && (
        <p role="status" className="card border-warn bg-warn-surface p-2 text-caption text-on-warn-surface">
          A library push goes into <span className="font-mono">{destination.slug}</span>, which
          belongs to another key. The store has no per-object permissions, so this works — and its
          owner will see your images.
        </p>
      )}
      {destination?.ownership === 'unknown' && (
        <p role="status" className="card border-warn bg-warn-surface p-2 text-caption text-on-warn-surface">
          A library push goes into <span className="font-mono">{destination.slug}</span>. Its folder
          record names no owner, so the app cannot tell whether this folder is yours — it is not
          claiming that it is, and it is not claiming that a different key owns it. The store has no
          per-object permissions, so the push works either way; anyone reading the folder will see
          your images.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/*
          THE PRIMARY PATH (owner's words: "the main thing was the local
          gallery"): images already made in Imager, pushed from the LOCAL library
          through the same uploader and encoder as everything else.
        */}
        <LibraryPushControl
          connection={connection}
          destination={destinationSlug}
          quality={quality}
          onPushed={onUploaded}
        />
        {/*
          The DEVICE picker stays exactly as it was: same label, same behaviour,
          still uploading into your own folder. Two visible sibling actions,
          each honest about what it takes.
        */}
        <label className={`${buttonClass('secondary')} cursor-pointer`}>
          {busy ? 'Working…' : 'Upload images…'}
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={busy}
            className="hidden"
            onChange={(event) => {
              onUpload(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={selected.length === 0}
          onClick={onDownloadClick}
        >
          {selected.length > 1
            ? `Download ${String(selected.length)} selected as one ZIP`
            : 'Download selected'}
        </button>
        <button
          type="button"
          className={buttonClass('ghost')}
          disabled={visibleImages.length === 0}
          onClick={() => {
            setSelected(visibleImages.map(imageKey));
          }}
        >
          Select all
        </button>
        <button
          type="button"
          className={buttonClass('ghost')}
          disabled={selected.length === 0}
          onClick={() => {
            setSelected([]);
          }}
        >
          Clear selection
        </button>
        {selected.length > 0 && selectedTags.length > 0 && (
          <span className="text-caption text-muted">
            Tags are not written to the store by a download.
          </span>
        )}
      </div>

      {progress.length > 0 && (
        <ul aria-label="Upload progress" className="card flex flex-col gap-1 p-2">
          {progress.map((row) => (
            <li key={row.key} className="flex flex-wrap items-baseline gap-2 text-caption">
              <span className="font-mono text-ink">{row.label}</span>
              {row.phase === 'failed' ? (
                <span className="text-danger">{row.error ?? 'failed'}</span>
              ) : (
                <span className="text-muted">
                  {row.phase === 'done' ? `stored as ${row.name ?? ''}` : row.phase}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FolderRow({
  folder,
  open,
  onOpen,
  onTogglePrivate,
  onRebuild,
  onMissingIndex,
}: Readonly<{
  folder: StoreFolderView;
  open: boolean;
  onOpen: () => void;
  onTogglePrivate?: ((value: boolean) => void) | undefined;
  onRebuild?: (() => void) | undefined;
  onMissingIndex?: boolean | undefined;
}>): React.JSX.Element {
  return (
    <div
      className={`mt-1 flex flex-col gap-1 rounded-md px-1 py-1 ${
        open ? 'bg-accent-soft text-ink' : 'text-muted'
      }`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 items-baseline gap-2 text-left">
        <span className="text-body">📁</span>
        <span className="min-w-0 flex-1 truncate text-body text-ink">{folder.displayName}</span>
        <span className="text-caption text-muted">{folder.images.length}</span>
      </button>
      <span className="text-caption text-muted">
        {folder.slug} ·{' '}
        {folder.ownership === 'unknown'
          ? 'no owner is recorded in its folder record'
          : `by ${folder.owner}`}
        {folder.private ? ' · private (this app honours it)' : ''}
      </span>
      {onMissingIndex === true && (
        <span className="text-caption text-danger">
          No readable index.{' '}
          {onRebuild !== undefined && (
            <button type="button" className={buttonClass('ghost')} onClick={onRebuild}>
              Rebuild from the store listing
            </button>
          )}
        </span>
      )}
      {onTogglePrivate !== undefined && (
        <label className="flex items-center gap-2 text-caption text-muted">
          <input
            type="checkbox"
            checked={folder.private}
            onChange={(event) => {
              onTogglePrivate(event.target.checked);
            }}
          />
          Private (honoured by this app, not enforced by the server)
        </label>
      )}
    </div>
  );
}

