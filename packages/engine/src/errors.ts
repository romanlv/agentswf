/** An error's message, or the thrown value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
