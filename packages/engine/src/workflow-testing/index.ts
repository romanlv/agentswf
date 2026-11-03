// What `agentswf/testing` publishes, which `awf test` serves too: nothing here is the engine's own.
import type { EventSchemas, JsonValue, Workflow, WorkflowMeta } from "@agentswf/contract/workflow";
import { runTest, type TestOptions, type TestRun, testCall } from "./run-test";

export type { DecisionRequest, DecisionScript } from "./decisions";
export type { TestTurn } from "./host";
export type {
  EarlierAttempt,
  EmittedEvent,
  EventTestOptions,
  FileTree,
  MessageRecord,
  ScriptedEvent,
  TestOptions,
  TestRun,
} from "./run-test";
export {
  answer,
  type Message,
  type MessageOutcome,
  type MessageScript,
  noAnswer,
  type ParticipantMessage,
  type ParticipantOutcome,
  type ParticipantRoute,
  type ParticipantScript,
  type ReceivedMessage,
  reply,
  type Script,
  type SendOptions,
  type TestTurnOutcome,
  type ToolOutcome,
  type Turn,
} from "./script";

/** What an array, `null` or a primitive is: args the deprecated form may give second. */
type NotAnObject = null | string | number | boolean | JsonValue[];

/**
 * Runs `workflow` through the real engine, answering each agent from its script and each decision
 * from its own. It rejects when a script cannot meet what the workflow asked, or leaves a list
 * unfinished, or the run stalls, or an option is one it doesn't take: those fail the test, never
 * the workflow.
 */
export async function testWorkflow<
  Args extends JsonValue,
  Result extends JsonValue,
  Events extends EventSchemas,
>(
  workflow: Workflow<Args, Result, Events> & { readonly events: Events },
  options?: TestOptions<NoInfer<Args>, NoInfer<Events>>,
): Promise<TestRun<Result>>;
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: Workflow<Args, Result>,
  ...options: null extends Args
    ? [options?: TestOptions<NoInfer<Args>>]
    : [options: TestOptions<NoInfer<Args>>]
): Promise<TestRun<Result>>;
/** @deprecated Give args among the options: `testWorkflow(workflow, { args, … })`. */
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: DeprecatedWorkflow<Args, Result>,
  args: NoInfer<Args>,
  options: Omit<TestOptions<NoInfer<Args>>, "args"> | undefined,
): Promise<TestRun<Result>>;
/** @deprecated Give args among the options: `testWorkflow(workflow, { args })`. */
export async function testWorkflow<Args extends NotAnObject, Result extends JsonValue>(
  workflow: DeprecatedWorkflow<Args, Result>,
  args: Args,
): Promise<TestRun<Result>>;
export async function testWorkflow(
  workflow: DeprecatedWorkflow<JsonValue, JsonValue>,
  ...given: unknown[]
): Promise<TestRun<JsonValue>> {
  const { options, used } = testCall(workflow, given);
  return runTest(workflow, options, { used });
}

/** What the deprecated form still takes: a workflow, or its `meta` and `run` alone. */
type DeprecatedWorkflow<Args extends JsonValue, Result extends JsonValue> = {
  readonly meta: WorkflowMeta;
  readonly events?: undefined;
  run: Workflow<Args, Result>["run"];
};
