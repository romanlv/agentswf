import type { EventSchemas, JsonValue, Workflow } from "@agentswf/contract/workflow";
import type { RunnableWorkflow } from "../workflow-runner";
import { type EventTestOptions, runTest, type TestOptions, type TestRun } from "./run-test";

export type { DecisionRequest, DecisionScript } from "./decisions";
export type { TestTurn } from "./host";
export type {
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

/**
 * Runs `workflow` through the real engine, answering each agent from its script and each decision
 * from its own. It rejects when a script cannot meet what the workflow asked, or leaves a list
 * unfinished, or the run stalls: those fail the test, never the workflow.
 */
export async function testWorkflow<
  Args extends JsonValue,
  Result extends JsonValue,
  Events extends EventSchemas,
>(
  workflow: Workflow<Args, Result, Events> & { readonly events: Events },
  options: EventTestOptions<NoInfer<Events>, NoInfer<Args>>,
): Promise<TestRun<Result>>;
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: RunnableWorkflow<Args, Result> & { readonly events?: undefined },
  args: NoInfer<Args>,
  options?: TestOptions,
): Promise<TestRun<Result>>;
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: RunnableWorkflow<Args, Result> | Workflow<Args, Result, EventSchemas>,
  args: NoInfer<Args>,
  options?: TestOptions,
): Promise<TestRun<Result>> {
  return runTest(workflow, args, options);
}
