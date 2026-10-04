import type { StageRecord } from "@agentswf/contract/records";

/**
 * Ends an attempt `stopped`, apart from `failed`: the workflow's `stop`, or a continue that can't
 * go on as asked. A continue picks it up from there.
 */
export class WorkflowStopped extends Error {
  constructor(
    readonly reason: string,
    /** The stage it stopped in; absent between stages. */
    readonly stage?: string,
    /** Whether going on takes `--from-stage {stage}`: a record a continue can't reuse. */
    readonly redo = false,
  ) {
    super(reason);
    this.name = "WorkflowStopped";
  }
}

/** A `--from-stage` the attempt never reached: a typo, or a branch not taken. */
export class FromStageUnreached extends WorkflowStopped {
  constructor(
    readonly fromStage: string,
    /** The run's stage records, in the order they started: the stages to choose from. */
    readonly recorded: readonly StageRecord[],
  ) {
    super(`never reached ${fromStage}`);
  }
}

/** The failure that ended an attempt: an aggregate's first, ahead of what cleanup added to it. */
export function primaryFailure(failure: unknown): unknown {
  return failure instanceof AggregateError ? failure.errors[0] : failure;
}
