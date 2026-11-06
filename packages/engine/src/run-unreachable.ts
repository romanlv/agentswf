/** A run's files that can't be read, or a run that doesn't answer: refused `unreachable`. */
export class RunUnreachable extends Error {
  readonly code = "unreachable";
  constructor(message: string) {
    super(message);
    this.name = "RunUnreachable";
  }
}

/** An error the system gave, `ENOENT`, `EACCES` and the like: a run's file that couldn't be read. */
export function isSystemError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code);
}
