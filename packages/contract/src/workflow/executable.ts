import type { JsonValue } from "./json";
import type { WorkflowDefinition } from "./workflow";

export const EXECUTABLE_WORKFLOW_KIND = "awf.executable-workflow/v1" as const;

export type WorkflowInvocation = Readonly<{
  argv: readonly string[];
  cwd: string;
}>;

/** Adapts operator input to one programmatic workflow call without owning runtime configuration. */
export interface ExecutableWorkflow<Args extends JsonValue, Result extends JsonValue> {
  readonly kind: typeof EXECUTABLE_WORKFLOW_KIND;
  readonly definition: WorkflowDefinition<Args, Result>;
  prepare(invocation: WorkflowInvocation): Args;
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
