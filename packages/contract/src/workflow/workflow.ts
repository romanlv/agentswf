import type { AgentDirectory, OperationRecord } from "./agents";
import type { WorkflowCallSpec } from "./composition";
import type { DecisionDirectory } from "./decisions";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { Messaging } from "./messaging";
import type { ParticipantDirectory } from "./participants";
import type { SandboxDirectory } from "./sandboxes";
import type { AbsoluteDeadline } from "./timing";

export type WorkflowRunId = string;
export type StepId = string;
export type SignalId = string;

export interface WorkflowMeta {
  /** What its runs are kept under; a file may move or be copied and stay the same workflow. */
  name: string;
  description: string;
  whenToUse?: string;
  /** Semver, recorded with each attempt. */
  version?: string;
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

/**
 * A stage's end: `stopped` is `workflow.stop` inside it; `failed` covers a throw, a value its
 * schema rejects, and a cancellation.
 */
export type StageOutcome = "succeeded" | "stopped" | "failed";

export interface StageOptions<T extends JsonValue> {
  /** Checks the value when the stage records it, and whenever a continue reuses it. */
  result: OutputSchema<T>;
  /** One line about the value, for the view and the record. */
  summary?: (value: T) => string;
}

export interface WorkflowContext {
  /** The run's id, the same in every attempt of it. */
  readonly runId: WorkflowRunId;
  /** Which `awf run` of the run this is: 1, then one more for each continue. */
  readonly attempt: number;
  /** Working directory and hard bound for this invocation, supplied and enforced by the engine. */
  readonly cwd: string;
  readonly deadline: AbsoluteDeadline;
  readonly agents: AgentDirectory;
  readonly sandboxes: SandboxDirectory;
  /** Closed questions to a decision model: probabilities back in a few hundred milliseconds. */
  readonly decisions: DecisionDirectory;
  readonly participants: ParticipantDirectory;
  readonly messages: Messaging;
  readonly steps: Steps;
  readonly signals: Signals;
  parallel<Item, Result>(
    items: readonly Item[],
    operation: (item: Item, index: number) => Promise<Result>,
    options?: ParallelOptions,
  ): Promise<Result[]>;

  /**
   * A named step of the run, recorded when it ends. One stage is open at a time, and a name is
   * entered once per attempt; parallel work goes inside a stage. A stage with `result` returns a
   * value it accepts; one without returns nothing.
   */
  stage(name: string, work: () => Promise<void>): Promise<void>;
  stage<T extends JsonValue>(
    name: string,
    options: StageOptions<T>,
    work: () => Promise<T>,
  ): Promise<T>;

  /**
   * Ends the attempt `stopped`, apart from failed: in the stage it is called from, which a continue
   * then redoes, or between stages, where a continue checks again. Caught, it fails the stage that
   * caught it, or the attempt when the workflow returns. `return workflow.stop(…)` narrows where a
   * bare call doesn't.
   */
  stop(reason: string): never;

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
