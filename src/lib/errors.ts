/** The message of any thrown value — the ONE home for the
 * `error instanceof Error ? error.message : String(error)` idiom. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
