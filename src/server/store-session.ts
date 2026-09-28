/**
 * THE ServerStore session seam (docs/17 row 42): the ONE place the app decides
 * whether the store is usable, which identity it holds, and which folder is
 * "mine".
 *
 * "ALL NON-STORE FUNCTIONS WORK REGARDLESS" (owner's decision): with no key,
 * with an unreachable service, or with a key the service refuses, this module
 * reports a state the UI can EXPLAIN — it never throws into the app shell, and
 * it never degrades another feature. `unconfigured` is the honest first-run
 * state, not an error.
 *
 * THE KEY IS A CREDENTIAL. It is read from the settings row (the same
 * browser-local place the OpenRouter key lives), put in exactly ONE header by
 * `store-client.ts`, and never logged, never in a URL, and never in an export
 * (`exportedSettingsSchema` is an allow-list). The error text this module
 * surfaces names codes and endpoints, never the key.
 */
import { getSettings, updateSettings } from '@/db/settingsRepo';
import type { Settings } from '@/domain/settings';
import { DEFAULT_BASE_URL, DEFAULT_STORE_NAME, whoami, type StoreTarget, type WhoAmI } from '@/server/store-client';
import { folderSlugForKey } from '@/server/store-folders';

/** What a valid connection provides. */
export interface StoreConnection {
  target: StoreTarget;
  who: WhoAmI;
  /** The slug this key's folder is under (stored choice first, else the label). */
  myFolder: string;
}

/**
 * The connection state the UI renders. Every member is EXPLAINABLE:
 *  * `unconfigured` — no key yet. The store surfaces say so and everything else works.
 *  * `connecting` — a `GET /whoami` is in flight.
 *  * `ready` — the key is proven; `connection` carries the identity and folder.
 *  * `failed` — the key or the service refused. `error` is shown verbatim.
 */
export type StoreState =
  | { status: 'unconfigured' }
  | { status: 'connecting' }
  | { status: 'ready'; connection: StoreConnection }
  | { status: 'failed'; error: unknown };

/** The stored ServerStore settings, with the defaults filled in. */
export interface StoreConfig {
  baseUrl: string;
  store: string;
  key: string;
  folder: string;
}

export function storeConfigFrom(settings: Settings): StoreConfig {
  return {
    baseUrl: settings.serverStoreBaseUrl.trim() === '' ? DEFAULT_BASE_URL : settings.serverStoreBaseUrl.trim(),
    store: settings.serverStoreName.trim() === '' ? DEFAULT_STORE_NAME : settings.serverStoreName.trim(),
    key: settings.serverStoreKey.trim(),
    folder: settings.serverStoreFolder.trim(),
  };
}

export function targetFrom(config: StoreConfig): StoreTarget {
  return { baseUrl: config.baseUrl, store: config.store, key: config.key };
}

/**
 * Try the stored key: `GET /whoami` is the ONE proof that a credential works
 * and the ONE source of the identity ("your folder" is derived from its label,
 * or from a first-run choice already stored).
 *
 * A `401`/`403` and a network failure are both reported as `failed` — never
 * swallowed, never retried in a loop.
 */
export async function connectStored(): Promise<StoreState> {
  const settings = await getSettings();
  const config = storeConfigFrom(settings);
  if (config.key === '') return { status: 'unconfigured' };
  try {
    const who = await whoami(targetFrom(config));
    const myFolder = folderSlugForKey(who, config.folder);
    if (config.folder === '') {
      // First run for this key: the label becomes the folder choice, STORED, so
      // the next visit does not silently re-derive a different one.
      await updateSettings({ serverStoreFolder: myFolder });
    }
    return { status: 'ready', connection: { target: targetFrom(config), who, myFolder } };
  } catch (error: unknown) {
    return { status: 'failed', error };
  }
}

/** Save a connection's settings, then prove them. One write, one proof. */
export async function connectWith(config: StoreConfig): Promise<StoreState> {
  await updateSettings({
    serverStoreBaseUrl: config.baseUrl,
    serverStoreName: config.store,
    serverStoreKey: config.key,
    serverStoreFolder: config.folder,
  });
  return connectStored();
}

/** The target for a stored connection, for a caller that already has settings. */
export function targetFor(settings: Settings): StoreTarget {
  return targetFrom(storeConfigFrom(settings));
}
