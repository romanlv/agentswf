import { constants } from "node:os";
import type { StageRecord } from "@agentswf/contract/records";
import {
  type AbsoluteDeadline,
  type AttemptOutcome,
  DeadlineExceededError,
  type Ending,
  type JsonValue,
  type StageSummary,
  type UnfinishedOutcome,
} from "@agentswf/contract/workflow";
import { PUBLISHED_PRICES } from "./accounting/prices";
import { summarizeRun } from "./accounting/summary";
import { messageOf } from "./errors";
import type { Paint } from "./progress-view";
import { FromStageUnreached, primaryFailure, WorkflowStopped } from "./stopped";
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
  /**
   * Given when the attempt never reached its `--from-stage`, which no one command goes on from:
   * the run's stages to choose from.
   */
  choose?: readonly StageRecord[];
};

/** What a started run came to: the result it returned, or what it threw. */
export type Finished = { result: WorkflowRunResult<JsonValue> } | { error: unknown };

/**
 * Each outcome: its word as awf reports it and as the calling session is told it, its mark, as its
 * last stage's would be, and its exit code, but for a cancellation's, which is its signal's. A
 * stop's is apart from a failure's: the run can go on with `--continue`.
 */
export const OUTCOMES: Record<
  AttemptOutcome,
  { word: string; told: string; mark: (paint: Paint) => string; exitCode?: number }
> = {
  completed: { word: "completed", told: "completed", mark: (p) => p.ok("✓"), exitCode: 0 },
  stopped: { word: "stopped", told: "stopped", mark: (p) => p.busy("■"), exitCode: 3 },
  cancelled: { word: "cancelled", told: "was cancelled", mark: (p) => p.busy("■") },
  "timed-out": { word: "timed out", told: "timed out", mark: (p) => p.bad("✗"), exitCode: 1 },
  failed: { word: "failed", told: "failed", mark: (p) => p.bad("✗"), exitCode: 1 },
};

/** The command that goes on from an attempt, given the stop that ended it and the stages it entered. */
export type GoOn = (stop: WorkflowStopped | undefined, entered: readonly StageSummary[]) => string;

/** The ending of a run that returned or threw. */
export function decideEnding(run: Finished, deadline: AbsoluteDeadline, goOn: GoOn): AttemptEnd {
  if ("result" in run) {
    const { result } = run;
    return {
      ending: { kind: "completed", value: result.value, stages: result.stages ?? [] },
      settled: result,
      exitCode: OUTCOMES.completed.exitCode!,
    };
  }
  const { error } = run;
  const settled = error instanceof WorkflowRunError ? error : undefined;
  const { kind, stop, cancellation } = runOutcome(error, deadline);
  const cause = unwrapped(error);
  const beside =
    stop && cause instanceof AggregateError
      ? cause.errors.slice(1).map(errorDetail).join("; ")
      : "";
  const stages = settled?.stages ?? [];
  return {
    ending: {
      kind,
      ...(settled?.endedIn === undefined ? {} : { stage: settled.endedIn }),
      // A stop's own, which the next attempt compares with its own stop's.
      reason: stop?.reason ?? errorDetail(error),
      stages,
      continue: goOn(stop, stages),
    },
    ...(settled ? { settled } : {}),
    exitCode: cancellation ? signalExitCode(cancellation.reason) : OUTCOMES[kind].exitCode!,
    ...(beside ? { alsoFailed: beside } : {}),
    ...(stop instanceof FromStageUnreached ? { choose: stop.recorded } : {}),
  };
}

/**
 * The ending of an attempt whose run never started, from what stopped it: it settled nothing, so
 * what it cost is nothing but the time from `run.startedAt` to `run.endedAt`.
 */
export function endedBeforeStart(
  error: unknown,
  deadline: AbsoluteDeadline,
  run: { runId: string; startedAt: number; endedAt: number },
  goOn: GoOn,
): AttemptEnd & { ending: Exclude<Ending<JsonValue>, { kind: "completed" }> } {
  const { kind, cancellation } = runOutcome(error, deadline);
  const times = {
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: new Date(run.endedAt).toISOString(),
  };
  return {
    ending: {
      kind,
      reason: cancellation ? "cancelled before it started" : errorDetail(error),
      stages: [],
      continue: goOn(undefined, []),
    },
    settled: {
      runId: run.runId,
      usage: [],
      ...times,
      accounting: summarizeRun([], PUBLISHED_PRICES, times, []),
    },
    exitCode: cancellation ? signalExitCode(cancellation.reason) : OUTCOMES[kind].exitCode!,
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
    exitCode: OUTCOMES.failed.exitCode!,
  };
}

/**
 * How a run that did not succeed ended, with the stop or the cancellation that decided it. The
 * operator cancelling wins. It timed out when its own deadline ended it: the body's failure, or the
 * first error of its aggregate, is a deadline error carrying the run's deadline. A deadline the
 * workflow set and let escape is its own failure.
 */
export function runOutcome(
  error: unknown,
  deadline: AbsoluteDeadline,
): { kind: UnfinishedOutcome; stop?: WorkflowStopped; cancellation?: WorkflowCancelledError } {
  const cancellation = findCancellation(error);
  const failure = primaryFailure(unwrapped(error));
  const stop = failure instanceof WorkflowStopped ? failure : undefined;
  const timedOut =
    failure instanceof DeadlineExceededError &&
    failure.deadline.unixMilliseconds === deadline.unixMilliseconds;
  const kind = cancellation ? "cancelled" : stop ? "stopped" : timedOut ? "timed-out" : "failed";
  return { kind, ...(stop ? { stop } : {}), ...(cancellation ? { cancellation } : {}) };
}

/** What the run threw, out of the wrapping that carries what it settled. */
function unwrapped(error: unknown): unknown {
  return error instanceof WorkflowRunError ? error.cause : error;
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
