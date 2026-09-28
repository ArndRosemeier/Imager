import { useCallback, useEffect, useRef, useState } from 'react';

import { buttonClass } from '@/components/styles';
import { EmptyState } from '@/components/ui';
import { getSettings } from '@/db/settingsRepo';
import { FolderDialog, type StoreFolderView } from '@/features/store/FolderDialog';
import { LibraryPushControl } from '@/features/store/LibraryPush';
import { saveStoreSelection } from '@/features/store/storeTransfer';
import { errorMessage, toError } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';
import { clearStoreCache, storeCacheStats } from '@/server/store-cache';
import { DEFAULT_BASE_URL, DEFAULT_STORE_NAME, healthz } from '@/server/store-client';
import {
  ensureIndex,
  readDirectory,
  visibleFolders,
  type Directory,
} from '@/server/store-folders';
import {
  connectStored,
  connectWith,
  storeConfigFrom,
  type StoreConfig,
  type StoreConnection,
  type StoreState,
} from '@/server/store-session';

/**
 * THE STORE TAB (docs/17 row 42): the connection form, the reachability check,
 * the folder dialog and the whole-batch upload/download actions.
 *
 * THE RULE THIS COMPONENT EXISTS TO HONOUR: "all non-store functions need to
 * work regardless." With no key, this tab explains itself and stops at the
 * form; it never throws, never blocks another tab, and never pretends the store
 * is there. An unreachable service or a refused key is the same: a stated
 * reason on screen, not a silent degradation.
 */
export function StoreArea(): React.JSX.Element {
  const [state, setState] = useState<StoreState>({ status: 'connecting' });
  const [config, setConfig] = useState<StoreConfig | null>(null);

  const connect = useCallback((next: StoreConfig): void => {
    setState({ status: 'connecting' });
    connectWith(next).then(setState, (error: unknown) => {
      setState({ status: 'failed', error: toError(error) });
    });
  }, []);

  const retry = useCallback((): void => {
    setState({ status: 'connecting' });
    connectStored().then(setState, (error: unknown) => {
      setState({ status: 'failed', error: toError(error) });
    });
  }, []);

  useEffect(() => {
    getSettings().then(
      (settings) => {
        setConfig(storeConfigFrom(settings));
      },
      (error: unknown) => {
        setState({ status: 'failed', error: toError(error) });
      },
    );
    retry();
  }, [retry]);

  if (state.status === 'connecting' || config === null) {
    return <p className="text-body text-muted">Checking the ServerStore…</p>;
  }

  if (state.status === 'failed') {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <StoreForm config={config} onConnect={connect} />
        <div
          role="alert"
          className="card flex flex-wrap items-center gap-2 border-danger bg-danger-surface p-3 text-on-danger-surface"
        >
          <span className="text-body">
            The ServerStore refused this key or could not be reached: {errorMessage(state.error)}
          </span>
          <button type="button" className={buttonClass('secondary')} onClick={retry}>
            Retry
          </button>
        </div>
        <p className="text-caption text-muted">
          Everything else in Imager keeps working without the store: your library, generating,
          refining, chat and export/import never need this key.
        </p>
        {/*
          The library push is reachable here on purpose: with no key the owner can
          still SEE his library and read exactly why it cannot be pushed yet, which
          is the degraded-mode rule made visible instead of a dead control.
        */}
        <div>
          <LibraryPushControl
            connection={null}
            destination={null}
            blockedReason="The ServerStore key was refused or the service could not be reached. Retry above, then push again — nothing leaves this browser until it succeeds."
            onPushed={() => undefined}
          />
        </div>
      </div>
    );
  }

  if (state.status === 'unconfigured') {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <StoreForm config={config} onConnect={connect} />
        <EmptyState
          title="No ServerStore key yet."
          hint="Ask the operator for a key scoped to the imager store. Until then every other part of Imager works exactly as before — this tab is the only thing that needs it."
        />
        <div>
          <LibraryPushControl connection={null} destination={null} onPushed={() => undefined} />
        </div>
      </div>
    );
  }

  return <ConnectedStore connection={state.connection} onUseDifferentKey={retry} />;
}

/**
 * The connected store surface. It takes a NON-NULL connection, which is what
 * lets every action below be typed against a proven key instead of re-checking
 * for one at each call site.
 */
function ConnectedStore({
  connection,
  onUseDifferentKey,
}: Readonly<{ connection: StoreConnection; onUseDifferentKey: () => void }>): React.JSX.Element {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [cacheLine, setCacheLine] = useState<string | null>(null);
  const [syncNonce, setSyncNonce] = useState(0);

  const [rebuilding, setRebuilding] = useState(false);
  const refresh = useCallback((): void => {
    setSyncNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    readDirectory(connection.target).then(
      (next) => {
        if (cancelled) return;
        setDirectory(next);
        setError(null);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(toError(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, syncNonce]);

  useEffect(() => {
    storeCacheStats().then(
      (stats) => {
        setCacheLine(
          `${String(stats.thumbs)} thumbnail${stats.thumbs === 1 ? '' : 's'} and ${String(stats.objects)} original${stats.objects === 1 ? '' : 's'} cached locally (${String(Math.round(stats.bytes / 1000))} kB). The store itself keeps the full-quality images.`,
        );
      },
      () => {
        setCacheLine('The local cache size could not be read.');
      },
    );
  }, [syncNonce]);

  const view = folderViews(directory, connection);
  const openFolder = openedFolder(view, connection);

  /*
   * THE LOUD REBUILD — ONCE PER MOUNTED FOLDER. An index that is absent or
   * unreadable is never rendered as an empty folder (docs/17 row 42): the
   * folder on screen is rebuilt from the store listing plus each image's own
   * header.
   *
   * WHY IT IS ATTEMPTED EXACTLY ONCE AND NOT "whenever it is missing": the
   * attempt is keyed by SLUG and remembered in a ref, NOT by the refresh
   * counter. Keyed on the counter it re-arms on every refresh while the
   * `directory` state still holds the OLD listing (React state lands after the
   * render that scheduled it), every refresh cancels the previous in-flight
   * read, and the two chase each other in a tight loop — MEASURED here as
   * thousands of rebuilds and a pegged CPU while this slice was being built. A
   * single attempt leaves an honest, stable state, and the dialog's "Rebuild
   * now" button is the repeatable door if it did not work.
   */
  const rebuildAttempted = useRef(new Set<string>());
  useEffect(() => {
    if (directory === null || openFolder?.missingIndex !== true) return;
    if (rebuildAttempted.current.has(openFolder.slug)) return;
    rebuildAttempted.current.add(openFolder.slug);
    const listing = directory.folders.find((folder) => folder.record.slug === openFolder.slug);
    if (listing === undefined) return;
    setRebuilding(true);
    ensureIndex(connection.target, { ...listing, index: null }, directory.byName)
      .then(
        () => {
          toastSuccess(
            `Rebuilt the index for "${openFolder.slug}"`,
            `From the store listing — ${String(listing.imageNames.length)} image${listing.imageNames.length === 1 ? '' : 's'} found.`,
          );
          refresh();
        },
        (failure: unknown) => {
          toastError(`Could not rebuild the index for "${openFolder.slug}"`, failure);
        },
      )
      .finally(() => {
        setRebuilding(false);
      });
  }, [directory, openFolder, connection, refresh]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <section
        aria-label="ServerStore connection"
        className="card flex flex-wrap items-start justify-between gap-3 p-3"
      >
        <div className="min-w-0">
          <h2 className="text-heading text-ink">
            ServerStore · {connection.who.label === '' ? connection.who.id : connection.who.label}
          </h2>
          <p className="text-caption text-muted">
            Key {connection.who.id} · scope {connection.who.stores.join(', ')} · perms{' '}
            {connection.who.perms.join(', ')}
            {connection.who.expiresAt === null ? '' : ` · expires ${connection.who.expiresAt}`}
          </p>
          <p className="text-caption text-muted">
            Your folder: <span className="font-mono">{connection.myFolder}</span> in store{' '}
            <span className="font-mono">{connection.target.store}</span> at{' '}
            <span className="font-mono">{connection.target.baseUrl}</span>
          </p>
          {cacheLine !== null && <p className="text-caption text-muted">{cacheLine}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass('secondary')}
            disabled={probe === 'Checking…'}
            onClick={() => {
              setProbe('Checking…');
              healthz(connection.target.baseUrl).then(
                (ok) => {
                  setProbe(
                    ok
                      ? 'The service answered /healthz.'
                      : 'The service answered, but not with ok:true.',
                  );
                },
                (failure: unknown) => {
                  setProbe(null);
                  toastError('The ServerStore did not answer /healthz', failure);
                },
              );
            }}
          >
            Check service
          </button>
          <button
            type="button"
            className={buttonClass('ghost')}
            onClick={() => {
              clearStoreCache().then(
                () => {
                  toastSuccess(
                    'Local store cache cleared',
                    'Nothing was deleted from the store — only the local copies.',
                  );
                  refresh();
                },
                (failure: unknown) => {
                  toastError('Could not clear the local store cache', failure);
                },
              );
            }}
          >
            Clear local cache
          </button>
          <button type="button" className={buttonClass('ghost')} onClick={onUseDifferentKey}>
            Use a different key
          </button>
        </div>
      </section>
      {probe !== null && <p className="text-caption text-muted">{probe}</p>}

      {/*
        The owner's own framing of the privacy flag, on screen and not in a
        tooltip: the app honours it, the SERVER does not — any key scoped to
        this store can read every object, so this is a courtesy between the
        app's own users and nothing more.
      */}
      <p className="text-caption text-muted">
        Every folder is visible to everyone by default. “Private” is honoured by THIS APP when it
        lists public folders — it is a courtesy between users of Imager, not a lock: the store has
        no per-object permissions, so anyone holding a key for this store can read every folder,
        including a private one. Do not put anything here that must stay secret.
      </p>

      {error !== null ? (
        <div
          role="alert"
          className="card flex flex-wrap items-center gap-2 border-danger bg-danger-surface p-3 text-on-danger-surface"
        >
          <span className="text-body">Could not read the store: {errorMessage(error)}</span>
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              setError(null);
              refresh();
            }}
          >
            Retry
          </button>
        </div>
      ) : directory === null ? (
        <p className="text-body text-muted">Reading the store listing…</p>
      ) : (
        <FolderDialog
          connection={connection}
          directory={directory}
          view={view}
          indexMissing={openFolder?.missingIndex ?? false}
          rebuilding={rebuilding}
          onRebuildIndex={
            openFolder === undefined
              ? undefined
              : () => {
                  setRebuilding(true);
                  const listing = directory.folders.find(
                    (folder) => folder.record.slug === openFolder.slug,
                  );
                  if (listing === undefined) return;
                  ensureIndex(connection.target, { ...listing, index: null }, directory.byName).then(
                    () => {
                      toastSuccess(
                        `Rebuilt the index for "${openFolder.slug}"`,
                        "From the store listing and each image's own header.",
                      );
                      refresh();
                    },
                    (failure: unknown) => {
                      toastError('Could not rebuild that folder index', failure);
                    },
                  ).finally(() => {
                    setRebuilding(false);
                  });
                }
          }
          onRefresh={refresh}
          onDownload={(selections) => {
            // The request (and with it the file picker) is built inside this
            // click; the fetch happens only after a destination exists.
            saveStoreSelection(connection, selections).catch((failure: unknown) => {
              toastError('Could not download from the store', failure);
            });
          }}
          onUploaded={refresh}
        />
      )}
    </div>
  );
}

/** The folder the dialog opens on: yours when it exists, else the first public one. */
function openedFolder(
  view: readonly StoreFolderView[],
  connection: StoreConnection,
): StoreFolderView | undefined {
  return (
    view.find((folder) => folder.slug === connection.myFolder) ??
    view.find((folder) => !folder.private) ??
    view[0]
  );
}

/**
 * The folders the dialog SHOWS: `visibleFolders` is the one place the
 * honour-based privacy rule is applied (yours always, everyone else's unless
 * flagged private). A folder that is not visible to this key is simply not in
 * the view — the dialog cannot forget to filter.
 */
function folderViews(directory: Directory | null, connection: StoreConnection): StoreFolderView[] {
  if (directory === null) return [];
  return visibleFolders(directory.folders, connection.myFolder).map((folder) => ({
    slug: folder.record.slug,
    displayName: folder.record.displayName,
    owner: folder.record.owner,
    private: folder.record.private,
    mine: folder.record.slug === connection.myFolder,
    missingIndex: folder.indexMissing,
    indexImageCount: folder.imageNames.length,
    images: (folder.index?.images ?? []).map((image) => ({
      name: image.name,
      sha256: image.sha256,
      size: image.size,
      tags: image.tags,
      createdAt: image.createdAt,
      mimeType: image.mimeType,
      folderSlug: folder.record.slug,
    })),
  }));
}

/** The connection form: the service URL, the store name and the key. */
function StoreForm({
  config,
  onConnect,
}: Readonly<{ config: StoreConfig; onConnect: (config: StoreConfig) => void }>): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl === '' ? DEFAULT_BASE_URL : config.baseUrl);
  const [store, setStore] = useState(config.store === '' ? DEFAULT_STORE_NAME : config.store);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="ServerStore key" className="card flex flex-col gap-2 p-3">
      <h2 className="text-heading text-ink">ServerStore</h2>
      <p className="text-caption text-muted">
        A key from the operator gives this app read/write access to the imager store. It is kept in
        this browser only (the app has no backend), is never logged, never put in a URL and never
        written into an export.
      </p>
      <div className="flex flex-wrap gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="store-base" className="block text-label text-ink">
            Service URL
          </label>
          <input
            id="store-base"
            className="field focus-visible:field-focus hover:field-hover mt-1 font-mono"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
            }}
          />
        </div>
        <div className="min-w-40 flex-1">
          <label htmlFor="store-name" className="block text-label text-ink">
            Store name
          </label>
          <input
            id="store-name"
            className="field focus-visible:field-focus hover:field-hover mt-1 font-mono"
            value={store}
            onChange={(event) => {
              setStore(event.target.value);
            }}
          />
        </div>
      </div>
      <div>
        <label htmlFor="store-key" className="block text-label text-ink">
          Access key
        </label>
        <input
          id="store-key"
          type="password"
          autoComplete="off"
          placeholder="ssk_…"
          className="field focus-visible:field-focus hover:field-hover mt-1 font-mono"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
          }}
        />
      </div>
      <div>
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={busy || key.trim() === ''}
          onClick={() => {
            setBusy(true);
            onConnect({ baseUrl, store, key: key.trim(), folder: '' });
          }}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </section>
  );
}
