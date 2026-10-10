import { z } from 'zod';

/**
 * User settings. EMPTY model ids are the owner's decision (docs/17 row 1b):
 * the app never picks a model — `''` is the visible "No model selected"
 * state, never a cue to substitute one.
 *
 * The four `serverStore*` fields (docs/17 row 42) configure the ONE
 * ServerStore seam. They carry `.default('')` so a settings row written before
 * this slice reads as the honest first-run state ("not configured"), exactly
 * the pattern `StoredImage.favorite`/`tags` established — and, because
 * `exportedSettingsSchema` is an ALLOW-LIST, they are dropped from any backup
 * by construction rather than by remembering to remove them.
 */
export const settingsSchema = z.strictObject({
  openRouterApiKey: z.string(),
  imageModel: z.string(),
  refineChatModel: z.string(),
  /**
   * The Music tab's two picks (docs/17 row 52): the model that RENDERS a song
   * (audio out) and the text model that WRITES the song sheet from the owner's
   * direction. `.default('')` so a row written before the Music tab reads as
   * "No model selected", the honest first-run state — never a substituted pick.
   */
  musicModel: z.string().default(''),
  songWriterModel: z.string().default(''),
  /**
   * The Videos tab's pick (docs/17 row 56): the model a video is generated
   * with. `.default('')` for the same reason as the music picks.
   */
  videoModel: z.string().default(''),
  /** The ServerStore HTTP origin, e.g. `https://store.futuremagic.de`. */
  serverStoreBaseUrl: z.string().default(''),
  /** The store objects live in. Fixed by the dispatcher's object model: `imager`. */
  serverStoreName: z.string().default(''),
  /** The access key (`ssk_…`). A credential: see `src/server/store-session.ts`. */
  serverStoreKey: z.string().default(''),
  /**
   * WHICH FOLDER IS "MINE" (the owner's "each user starts in his folder").
   * Derived from `GET /whoami`'s label on the first connect and then stored, so
   * the choice is explicit and the owner can change it; see
   * `slugFromLabel` in `src/server/store-folders.ts`.
   */
  serverStoreFolder: z.string().default(''),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * The defaults. The ServerStore base URL is the ONE deployment this app talks
 * to (measured reachable, docs/17 row 42); it is still a stored field so the
 * app can be pointed at a local store without a code change.
 */
export const DEFAULT_SETTINGS: Settings = {
  openRouterApiKey: '',
  imageModel: '',
  refineChatModel: '',
  musicModel: '',
  songWriterModel: '',
  videoModel: '',
  serverStoreBaseUrl: 'https://store.futuremagic.de',
  serverStoreName: 'imager',
  serverStoreKey: '',
  serverStoreFolder: '',
};
