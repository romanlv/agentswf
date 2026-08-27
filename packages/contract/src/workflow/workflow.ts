import type { AgentDirectory, TurnUsage } from "./agents";
import type { WorkflowCallSpec } from "./composition";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { Messaging } from "./messaging";
import type { ParticipantDirectory } from "./participants";

export type WorkflowRunId = string;
export type StepId = string;
export type SignalId = string;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
}

export type ReplayPolicy =
  | { kind: "never" }
  | { kind: "journal"; fingerprint: string };

export interface StepSpec {
  /** Idempotency key scoped to this workflow context. Reusing it with a different spec rejects. */
  id: StepId;
  label?: string;
  /** Defaults to `never`; journal replay is safe only when the fingerprint covers every input. */
  replay?: ReplayPolicy;
}

export interface Steps {
  run<T extends JsonValue>(spec: StepSpec, operation: () => Promise<T>): Promise<T>;
  sleep(spec: StepSpec & { milliseconds: number }): Promise<void>;
}

export interface ParallelOptions {
  /** Positive integer local maximum; global admission may reduce it. */
  concurrency?: number;
  label?: string;
}

export interface SignalSpec {
  /** Idempotency key scoped to this workflow context. Reusing it with a different spec rejects. */
  id: SignalId;
  name: string;
}

export interface Signals {
  /** Waits for and journals one value; replay with the same id returns that value. */
  receive(spec: SignalSpec): Promise<string>;
  receive<T extends JsonValue>(spec: SignalSpec, schema: OutputSchema<T>): Promise<T>;
}

export interface WorkflowContext {
  readonly runId: WorkflowRunId;
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

  /** Completed usage in this workflow scope and its descendants, ordered by dispatch. */
  usage(): TurnUsage[];

  log(message: string, fields?: JsonObject): void;
}

export interface WorkflowDefinition<Args extends JsonValue, Result extends JsonValue> {
  readonly meta: WorkflowMeta;
  run(context: WorkflowContext, args: Args): Promise<Result>;
}
