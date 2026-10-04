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
