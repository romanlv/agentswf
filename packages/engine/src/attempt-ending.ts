import { constants } from "node:os";
import {
  type AbsoluteDeadline,
  DeadlineExceededError,
  type Ending,
  type JsonValue,
  type UnfinishedOutcome,
} from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { primaryFailure, WorkflowStopped } from "./stopped";
import {
  type SettledRun,
  WorkflowCancelledError,
  WorkflowRunError,
  type WorkflowRunResult,
} from "./workflow-runner";

/**
 * How an attempt ended, decided once: every record, message and exit code of it follows this.
 * `settled` is what the run left, absent when it failed before it started.
 */
export type AttemptEnd = {
  ending: Ending<JsonValue>;
  settled?: SettledRun;
  exitCode: number;
  /** What else failed beside a stop, which its reason leaves out. */
  alsoFailed?: string;
};

/** A stop's exit code, apart from a failure's: the run can go on with `--continue`. */
const STOPPED_EXIT_CODE = 3;

/** Each outcome in words: as the calling session is told it, and as awf reports it. */
export const ENDINGS = {
  stopped: { told: "stopped", ended: "stopped" },
  cancelled: { told: "was cancelled", ended: "cancelled" },
  "timed-out": { told: "timed out", ended: "timed out" },
  failed: { told: "failed", ended: "failed" },
} as const satisfies Record<UnfinishedOutcome, { told: string; ended: string }>;

/**
 * The ending of a run that returned or threw. `goOn` is the command that continues it, given the
 * stop that ended it, if one did.
 */
export function attemptEnd(
  run: { result: WorkflowRunResult<JsonValue> } | { error: unknown },
  deadline: AbsoluteDeadline,
  goOn: (stop: WorkflowStopped | undefined) => string,
): AttemptEnd {
  if ("result" in run) {
    const { result } = run;
    return {
      ending: { kind: "completed", value: result.value, stages: result.stages ?? [] },
      settled: result,
      exitCode: 0,
    };
  }
  const { error } = run;
  const settled = error instanceof WorkflowRunError ? error : undefined;
  const kind = runOutcome(error, deadline);
  const stop = stopOf(error);
  const cause = error instanceof WorkflowRunError ? error.cause : error;
  const beside =
    stop && cause instanceof AggregateError
      ? cause.errors.slice(1).map(errorDetail).join("; ")
      : "";
  const cancellation = findCancellation(error);
  return {
    ending: {
      kind,
      ...(settled?.endedIn === undefined ? {} : { stage: settled.endedIn }),
      // A stop's own, which the next attempt compares with its own stop's.
      reason: stop?.reason ?? errorDetail(error),
      stages: settled?.stages ?? [],
      continue: goOn(stop),
    },
    ...(settled ? { settled } : {}),
    exitCode: cancellation
      ? signalExitCode(cancellation.reason)
      : kind === "stopped"
        ? STOPPED_EXIT_CODE
        : 1,
    ...(beside ? { alsoFailed: beside } : {}),
  };
}

/**
 * A completed attempt whose runtime then failed to clean up is failed: no record of it may say it
 * completed. Any other ending stands, the cleanup's failure said beside it.
 */
export function cleanupFailed(end: AttemptEnd, error: unknown, goOn: string): AttemptEnd {
  if (end.ending.kind !== "completed") return end;
  return {
    ...end,
    ending: {
      kind: "failed",
      reason: `runtime cleanup failed: ${messageOf(error)}`,
      stages: end.ending.stages,
      continue: goOn,
    },
    exitCode: 1,
  };
}

/**
 * How a run that did not succeed ended. The operator cancelling wins. It timed out when its own
 * deadline ended it: the body's failure, or the first error of its aggregate, is a deadline error
 * carrying the run's deadline. A deadline the workflow set and let escape is its own failure.
 */
export function runOutcome(error: unknown, deadline: AbsoluteDeadline): UnfinishedOutcome {
  if (findCancellation(error)) return "cancelled";
  if (stopOf(error)) return "stopped";
  const failure = primaryFailure(error instanceof WorkflowRunError ? error.cause : error);
  return failure instanceof DeadlineExceededError &&
    failure.deadline.unixMilliseconds === deadline.unixMilliseconds
    ? "timed-out"
    : "failed";
}

/** The stop that ended a run, as `runOutcome` finds it. */
function stopOf(error: unknown): WorkflowStopped | undefined {
  const failure = primaryFailure(error instanceof WorkflowRunError ? error.cause : error);
  return failure instanceof WorkflowStopped ? failure : undefined;
}

function findCancellation(error: unknown): WorkflowCancelledError | undefined {
  if (error instanceof WorkflowCancelledError) return error;
  if (error instanceof WorkflowRunError) return findCancellation(error.cause);
  if (!(error instanceof AggregateError)) return undefined;
  for (const nested of error.errors) {
    const cancellation = findCancellation(nested);
    if (cancellation) return cancellation;
  }
  return undefined;
}

function errorDetail(error: unknown): string {
  if (error instanceof WorkflowRunError) return errorDetail(error.cause);
  return error instanceof AggregateError
    ? error.errors.map(errorDetail).join("; ")
    : messageOf(error);
}

/** A shell's code for a process ended by `reason`, as if the signal had killed it. */
export function signalExitCode(reason: unknown): number {
  const number = constants.signals[reason as keyof typeof constants.signals];
  return 128 + (number ?? constants.signals.SIGINT);
}
