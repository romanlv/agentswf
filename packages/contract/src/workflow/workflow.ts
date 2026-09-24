import type { AgentDirectory, OperationRecord } from "./agents";
import type { WorkflowCallSpec } from "./composition";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { Messaging } from "./messaging";
import type { ParticipantDirectory } from "./participants";
import type { AbsoluteDeadline } from "./timing";

export type WorkflowRunId = string;
export type StepId = string;
export type SignalId = string;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
}

export interface StepSpec {
  /** Idempotency key scoped to this workflow context. Reusing it with a different spec rejects. */
  id: StepId;
  label?: string;
}

export interface Steps {
  run<T extends JsonValue>(
    spec: StepSpec & { deadline?: AbsoluteDeadline },
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Its requested duration is already a bound, so sleep has no second deadline. */
  sleep(spec: StepSpec & { milliseconds: number }): Promise<void>;
}

export interface ParallelOptions {
  /** Defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Positive integer local maximum; global admission may reduce it. */
  concurrency?: number;
  label?: string;
}

export interface SignalSpec {
  /** Idempotency key scoped to this workflow context. Reusing it with a different spec rejects. */
  id: SignalId;
  name: string;
  /** Defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
}

export interface Signals {
  /** Waits for one value and suspends only this branch, never workflow admission. */
  receive(spec: SignalSpec): Promise<string>;
  receive<T extends JsonValue>(spec: SignalSpec, schema: OutputSchema<T>): Promise<T>;
}

export interface WorkflowContext {
  readonly runId: WorkflowRunId;
  /** Working directory and hard bound for this invocation, supplied and enforced by the engine. */
  readonly cwd: string;
  readonly deadline: AbsoluteDeadline;
  readonly agents: AgentDirectory;
  readonly participants: ParticipantDirectory;
  readonly messages: Messaging;
  readonly steps: Steps;
  readonly signals: Signals;
  parallel<Item, Result>(
    items: readonly Item[],
    operation: (item: Item, index: number) => Promise<Result>,
    options?: ParallelOptions,
  ): Promise<Result[]>;

  call<Args extends JsonValue, Result extends JsonValue>(
    spec: WorkflowCallSpec<Args, Result>,
  ): Promise<Result>;

  /** Completed operations in this workflow scope and its descendants, ordered by dispatch. */
  usage(): OperationRecord[];

  log(message: string, fields?: JsonObject): void;
}

export interface WorkflowDefinition<Args extends JsonValue, Result extends JsonValue> {
  readonly meta: WorkflowMeta;
  run(context: WorkflowContext, args: Args): Promise<Result>;
}
