import { SETTINGS_ID, db } from '@/db/db';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '@/domain/settings';

/** Reads the settings row. No row yet → the (empty) defaults — a genuine
 * first-run preference state. A row that fails the schema THROWS: a corrupt
 * row is never silently replaced by defaults (rule 1). */
export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get(SETTINGS_ID);
  if (row === undefined) return { ...DEFAULT_SETTINGS };
  const { id: _id, ...rest } = row;
  const parsed = settingsSchema.safeParse(rest);
  if (!parsed.success) {
    throw new Error(`Stored settings are corrupt: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await db.settings.put({ ...next, id: SETTINGS_ID });
  return next;
}
