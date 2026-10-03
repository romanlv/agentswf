import { type AbsoluteDeadline, DeadlineExceededError } from "@agentswf/contract/workflow";
import type { NativeFork } from "../adapter";
import type { ProcessInput, ProcessResult } from "../command";
import type { ForkPlan } from "../spec";
import type { Harness } from "../types";

/** The process a fork plan runs as, bounded by `deadline`. */
export function forkCommand(
  plan: ForkPlan,
  options: {
    cwd: string;
    env: Record<string, string>;
    deadline: AbsoluteDeadline;
    signal: AbortSignal;
  },
): ProcessInput & { env: Record<string, string> } {
  const remaining = options.deadline.unixMilliseconds - Date.now();
  if (remaining <= 0) throw new DeadlineExceededError(options.deadline);
  return {
    argv: plan.argv,
    cwd: options.cwd,
    env: options.env,
    ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
    ...(plan.holdStdinUntil ? { holdStdinUntil: plan.holdStdinUntil } : {}),
    timeoutMs: Math.max(1, remaining),
    signal: options.signal,
  };
}

/** What the fork plan's process left: the new session, or why there is none. */
export function forkResult(
  harness: Harness,
  plan: ForkPlan,
  result: ProcessResult,
  deadline: AbsoluteDeadline,
): NativeFork {
  if (result.cancelled) throw new Error("the fork was cancelled");
  // A held server answered before it was made to exit: its exit says nothing about the fork.
  if (!result.answered) {
    if (result.timedOut) throw new DeadlineExceededError(deadline);
    if (result.exitCode !== 0) {
      throw new Error(
        `${plan.argv[0]} exited ${result.exitCode} forking: ${result.stderr.trim().slice(0, 400)}`,
      );
    }
  }
  const read = plan.read(result.stdout);
  if ("error" in read) throw new Error(read.error);
  return {
    harness,
    sessionRef: read.sessionId,
    ...(read.costTotal === undefined ? {} : { costTotal: read.costTotal }),
  };
}
