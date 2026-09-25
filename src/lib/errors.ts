/** The message of any thrown value — the ONE home for the
 * `error instanceof Error ? error.message : String(error)` idiom. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Any thrown value as an Error — the ONE home for that coercion. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
