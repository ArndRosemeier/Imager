import { z } from 'zod';

/**
 * User settings. EMPTY model ids are the owner's decision (docs/17 row 1b):
 * the app never picks a model — `''` is the visible "No model selected"
 * state, never a cue to substitute one.
 */
export const settingsSchema = z.strictObject({
  openRouterApiKey: z.string(),
  imageModel: z.string(),
  refineChatModel: z.string(),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  openRouterApiKey: '',
  imageModel: '',
  refineChatModel: '',
};
