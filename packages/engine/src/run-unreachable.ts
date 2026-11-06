/** A run's files that can't be read, or a run that doesn't answer: refused `unreachable`. */
export class RunUnreachable extends Error {
  readonly code = "unreachable";
  constructor(message: string) {
    super(message);
    this.name = "RunUnreachable";
  }
}

/**
 * An error the system gave, `ENOENT`, `EACCES` and the like, or one awf wrapped around it as its
 * cause: a run's file that couldn't be read or written.
 */
export function isSystemError(error: unknown): boolean {
  const { code, cause } = (error ?? {}) as { code?: unknown; cause?: unknown };
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return true;
  return cause !== undefined && cause !== error && isSystemError(cause);
}
