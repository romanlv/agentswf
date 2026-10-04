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

/** How an attempt ended, which `present` and `report` render. */
export type Ending<Result> =
  | { kind: "completed"; value: Result; stages: StageSummary[] }
  | {
      kind: "stopped" | "failed" | "timed-out" | "cancelled";
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
   * Renders how the attempt ended for a person at a terminal: its value, or how it stopped with
   * what its stages found. Undefined, or no `present`, and awf prints its own: the JSON, or the
   * stage, the reason and the command that goes on.
   */
  present?(ending: Ending<Result>): string | undefined;
  /**
   * A Markdown handoff of how the attempt ended for whoever acts on it; the operator saves it as
   * report.md. Undefined writes none.
   */
  report?(ending: Ending<Result>): string | undefined;
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
