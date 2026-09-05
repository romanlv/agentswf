/** An absolute wall-clock deadline. `unixMilliseconds` is a non-negative finite integer. */
export type AbsoluteDeadline = {
  unixMilliseconds: number;
};

/** The single machine-readable rejection used by workflow waits without terminal outcomes. */
export class DeadlineExceededError extends Error {
  readonly code = "deadline-exceeded" as const;

  constructor(readonly deadline: AbsoluteDeadline) {
    super(`Deadline exceeded at ${deadline.unixMilliseconds}`);
    this.name = "DeadlineExceededError";
  }
}
