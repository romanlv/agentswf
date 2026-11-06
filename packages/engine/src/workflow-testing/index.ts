// What `agentswf/testing` publishes, which `awf test` serves too: nothing here is the engine's own.
import type { EventSchemas, JsonValue, Workflow } from "@agentswf/contract/workflow";
import { runTest, type TestOptions, type TestRun, testCall } from "./run-test";

export type { DecisionRequest, DecisionScript } from "./decisions";
export {
  type FakeClient,
  type FakeClientCall,
  type FakeClientScript,
  fakeClient,
} from "./fake-client";
export type { TestTurn } from "./host";
export type {
  EarlierAttempt,
  EmittedEvent,
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
  type Script,
  type SendOptions,
  type TestTurnOutcome,
  type ToolOutcome,
  type Turn,
} from "./script";

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
export async function testWorkflow(
  workflow: Parameters<typeof runTest>[0],
  ...given: unknown[]
): Promise<TestRun<JsonValue>> {
  return runTest(workflow, testCall(workflow, given));
}
