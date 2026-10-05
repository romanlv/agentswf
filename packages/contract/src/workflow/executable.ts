import type { JsonValue } from "./json";
import type { StageOutcome, WorkflowDefinition } from "./workflow";

export const EXECUTABLE_WORKFLOW_KIND = "awf.executable-workflow/v1" as const;

export type WorkflowInvocation = Readonly<{
  argv: readonly string[];
  cwd: string;
}>;

/** One stage an attempt entered: run, or reused from the attempt that ran it. */
export type StageSummary = {
  stage: string;
  source: "ran" | "reused";
  outcome: StageOutcome;
  /** The attempt that ran it. */
  attempt: number;
  /** How long it ran in this attempt: zero for a reused one. */
  spanMs: number;
  summary?: string;
  /** Its value, for a stage that returns one and succeeded. */
  value?: JsonValue;
};

/** How an attempt ended. `interrupted` is never written: it is an attempt with no ending and no process. */
export type AttemptOutcome = "completed" | UnfinishedOutcome;

/**
 * How an attempt that didn't complete ended. `cancelled` is the operator stopping it, and wins over
 * the others. `timed-out` is its own deadline ending it; a deadline the workflow set and let escape
 * is `failed`. `stopped` is a stop: the workflow's, or a continue that can't go on as asked.
 */
export type UnfinishedOutcome = "stopped" | "failed" | "timed-out" | "cancelled";

/** How an attempt ended, which `report` renders. */
export type Ending<Result> =
  | { kind: "completed"; value: Result; stages: StageSummary[] }
  | {
      kind: UnfinishedOutcome;
      /** The stage it ended in; absent between stages. */
      stage?: string;
      reason: string;
      stages: StageSummary[];
      /** The command that goes on from here. */
      continue: string;
    };

/**
 * Adapts operator input to one programmatic workflow call, and its result back to the operator,
 * without owning runtime configuration.
 */
export interface ExecutableWorkflow<Args extends JsonValue, Result extends JsonValue> {
  readonly kind: typeof EXECUTABLE_WORKFLOW_KIND;
  readonly definition: WorkflowDefinition<Args, Result>;
  prepare(invocation: WorkflowInvocation): Args;
  /**
   * The run's id, derived from its args, such as a ticket's key: unique within the workflow,
   * letters, digits, `.`, `_` and `-`. `awf run --id` overrides it; without either, one is
   * generated.
   */
  id?(args: Args): string;
  /**
   * Renders a completed attempt's value for a person at a terminal. Undefined, or no `present`, and
   * awf prints the JSON. An attempt that didn't complete is awf's to print: its stage, its reason
   * and the command that goes on.
   */
  present?(value: Result, ending: Ending<Result>): string | undefined;
  /**
   * A Markdown handoff of how the attempt ended for whoever acts on it, which the operator saves as
   * report.md. Called for every ending, `value` only for a completed one, so a stopped attempt can
   * hand off what its stages found. Undefined writes none.
   */
  report?(value: Result | undefined, ending: Ending<Result>): string | undefined;
}

type ExecutableWorkflowSpec<Args extends JsonValue, Result extends JsonValue> = Omit<
  ExecutableWorkflow<Args, Result>,
  "kind"
>;

export function defineExecutableWorkflow<Args extends JsonValue, Result extends JsonValue>(
  spec: ExecutableWorkflowSpec<Args, Result>,
): ExecutableWorkflow<Args, Result> {
  return { ...spec, kind: EXECUTABLE_WORKFLOW_KIND };
}
