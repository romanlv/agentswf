import { type AbsoluteDeadline, DeadlineExceededError } from "@agentswf/contract/workflow";

export class WorkflowCancelledError extends Error {
  constructor(readonly reason: unknown) {
    super("workflow cancelled by operator");
    this.name = "WorkflowCancelledError";
  }
}

/**
 * Races `execute` against `signal` and `deadline`, if there is one; losing the race does not stop
 * `execute`.
 */
export async function runUntilStopped<T>(
  execute: () => Promise<T>,
  signal: AbortSignal | undefined,
  deadline: AbsoluteDeadline | undefined,
): Promise<T> {
  if (signal?.aborted) throw new WorkflowCancelledError(signal.reason);
  if (deadline && Date.now() >= deadline.unixMilliseconds)
    throw new DeadlineExceededError(deadline);
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const abort = () => rejectStopped(new WorkflowCancelledError(signal?.reason));
  signal?.addEventListener("abort", abort, { once: true });
  const cancelDeadline = deadline
    ? scheduleAt(deadline, () => {
        rejectStopped(new DeadlineExceededError(deadline));
      })
    : () => undefined;
  try {
    return await Promise.race([execute(), stopped]);
  } finally {
    cancelDeadline();
    signal?.removeEventListener("abort", abort);
  }
}

export function waitForDeadline<T>(
  promise: Promise<T>,
  deadline: AbsoluteDeadline | undefined,
): Promise<T> {
  if (!deadline) return promise;
  let cancelTimer: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    cancelTimer = scheduleAt(deadline, () => reject(new DeadlineExceededError(deadline)));
  });
  return Promise.race([promise, expired]).finally(() => cancelTimer?.());
}

export function scheduleAt(deadline: AbsoluteDeadline, action: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = deadline.unixMilliseconds - Date.now();
    if (remaining <= 0) {
      action();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/** The earlier of two deadlines, an absent one being none. */
export function earlierDeadline(
  left: AbsoluteDeadline,
  right: AbsoluteDeadline | undefined,
): AbsoluteDeadline;
export function earlierDeadline(
  left: AbsoluteDeadline | undefined,
  right: AbsoluteDeadline | undefined,
): AbsoluteDeadline | undefined;
export function earlierDeadline(
  left: AbsoluteDeadline | undefined,
  right: AbsoluteDeadline | undefined,
): AbsoluteDeadline | undefined {
  if (!left || !right) return left ?? right;
  return left.unixMilliseconds <= right.unixMilliseconds ? left : right;
}

export function laterDeadline(left: AbsoluteDeadline, right: AbsoluteDeadline): AbsoluteDeadline {
  return left.unixMilliseconds >= right.unixMilliseconds ? left : right;
}

export function deadlineWithin(
  milliseconds: number,
  ceiling: AbsoluteDeadline | undefined,
): AbsoluteDeadline {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  return earlierDeadline({ unixMilliseconds: Date.now() + milliseconds }, ceiling);
}

export function assertDeadline(deadline: AbsoluteDeadline | undefined): void {
  if (!deadline) return;
  assertDeadlineValue(deadline);
  if (Date.now() >= deadline.unixMilliseconds) {
    throw new DeadlineExceededError(deadline);
  }
}

export function assertDeadlineValue(deadline: AbsoluteDeadline): void {
  if (!Number.isSafeInteger(deadline.unixMilliseconds) || deadline.unixMilliseconds < 0) {
    throw new Error("deadline.unixMilliseconds must be a non-negative safe integer");
  }
}

/**
 * What a harness bounds a run, an agent or a turn by when nothing else does. Workflow code sees no
 * deadline then; a harness needs one, and a timer cannot wait past about 24.8 days.
 */
const HARNESS_BOUND_MS = 7 * 24 * 60 * 60_000;

export function harnessDeadline(deadline: AbsoluteDeadline | undefined): AbsoluteDeadline {
  return deadline ?? { unixMilliseconds: Date.now() + HARNESS_BOUND_MS };
}

/** Waits `milliseconds`, or until `signal` aborts, whichever is first. */
export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
