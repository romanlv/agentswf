/** An absolute wall-clock deadline. `unixMilliseconds` is a non-negative finite integer. */
export type AbsoluteDeadline = {
  unixMilliseconds: number;
};

/** The single machine-readable rejection used by workflow waits without terminal outcomes. */
export class DeadlineExceededError extends Error {
  readonly code = "deadline-exceeded" as const;

  /** When it passed, a `Date` as every deadline an author sets is. */
  readonly deadline: Date;

  constructor(deadline: AbsoluteDeadline) {
    super(`Deadline exceeded at ${new Date(deadline.unixMilliseconds).toISOString()}`);
    this.name = "DeadlineExceededError";
    this.deadline = new Date(deadline.unixMilliseconds);
  }
}
