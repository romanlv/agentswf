import type { AgentDirectory, EventAgentDirectory, HarnessKind, OperationRecord } from "./agents";
import type { HarnessAllowance } from "./allowance";
import type { WorkflowCallSpec } from "./composition";
import type { DecisionDirectory } from "./decisions";
import type {
  EmitOptions,
  EmitOutcome,
  EventSchemas,
  OutputOf,
  ReceivedEvent,
  ReceiveOptions,
} from "./events";
import type { ExecutableEventWorkflow } from "./executable";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { Messaging } from "./messaging";
import type { CodeParticipantDirectory, ParticipantDirectory } from "./participants";
import type { SandboxDirectory } from "./sandboxes";
import type { AbsoluteDeadline } from "./timing";

export type WorkflowRunId = string;
export type StepId = string;

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
  /** The run's deadline; absent when it has none, as it has unless `awf run --timeout` sets one. */
  readonly deadline?: AbsoluteDeadline;
  readonly agents: AgentDirectory;
  readonly sandboxes: SandboxDirectory;
  /** Closed questions to a decision model: probabilities back in a few hundred milliseconds. */
  readonly decisions: DecisionDirectory;
  readonly participants: ParticipantDirectory;
  readonly messages: Messaging;
  readonly steps: Steps;
  parallel<Item, Result>(
    items: readonly Item[],
    operation: (item: Item, index: number) => Promise<Result>,
    options?: ParallelOptions,
  ): Promise<Result[]>;

  /**
   * A named step of the run, recorded when it ends. One stage is open at a time, and a name is
   * entered once per attempt; parallel work goes inside a stage. A stage with `result` returns a
   * value it accepts; one without returns nothing. In a run of a workflow with `events`, a stage is
   * named by its one effect and runs once ever: a succeeded record is reused wherever and however
   * often its name is entered, whatever version of the code recorded it, while its value fits.
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

  /**
   * Sends an event to the run of the workflow `target` whose id is `run`: the run starts if it has
   * none and the event is one that starts one, and is woken if it has one. A name `target`
   * doesn't declare, or data its schema refuses, throws; the run's state is the outcome.
   */
  emit<Events extends EventSchemas, Name extends keyof Events & string>(
    target: ExecutableEventWorkflow<Events, JsonValue>,
    run: string,
    name: Name,
    data: OutputOf<Events[Name]>,
    options?: EmitOptions,
  ): Promise<EmitOutcome>;

  /** Completed operations in this workflow scope and its descendants, ordered by dispatch. */
  usage(): OperationRecord[];

  /**
   * What is left of `harness`'s plan, read now as `awf allowance` reads it, with no model turn: the
   * login the run's agents get. Not recorded, so a rerun reads again; a `none` is unknown, not room
   * to spare. A harness awf doesn't know throws.
   */
  allowance(harness: HarnessKind): Promise<HarnessAllowance>;

  log(message: string, fields?: JsonObject): void;
}

export interface WorkflowDefinition<Args extends JsonValue, Result extends JsonValue> {
  readonly meta: WorkflowMeta;
  run(context: WorkflowContext, args: Args): Promise<Result>;
}

/**
 * A run of a workflow with `events`: named by whoever starts it or sends to it, started by an event
 * or `awf run --id`, and
 * waiting for the next at `receive`. Waiting with no turn running and nothing unacknowledged, it parks: its process
 * exits, and the next event continues it from the top. What must outlive that lives in files or a
 * stage.
 */
export interface EventWorkflowContext<Events extends EventSchemas>
  extends Omit<WorkflowContext, "participants" | "agents" | "stage"> {
  readonly agents: EventAgentDirectory;
  readonly participants: CodeParticipantDirectory;
  /**
   * As `WorkflowContext.stage`, and a stage around a wait: `stage(name, () => workflow.receive(…))`
   * returns the batch that wait took, then and on every rerun, read back from the mailbox, so a
   * wait in straight-line code takes no later events. The batch counts as acknowledged. Its work is
   * the wait alone: one that returns other events than one wait took fails the stage.
   */
  stage(name: string, work: () => Promise<void>): Promise<void>;
  stage(
    name: string,
    work: () => Promise<ReceivedEvent<Events>[]>,
  ): Promise<ReceivedEvent<Events>[]>;
  stage<T extends JsonValue>(
    name: string,
    options: StageOptions<T>,
    work: () => Promise<T>,
  ): Promise<T>;
  /**
   * Acknowledges what the last call returned, then waits for events not yet acknowledged and
   * returns them in arrival order: the first call of a run takes the event that started it, if one did. After
   * a crash, the first call returns the batch taken and not acknowledged, alone. In a stage, it
   * returns the stage's recorded batch on a rerun.
   */
  receive(options?: ReceiveOptions): Promise<ReceivedEvent<Events>[]>;
}

/**
 * A workflow whose runs take events: it takes no arguments, and a run starts from an event, or from
 * `awf run --id`, which leaves it waiting at its first `receive`.
 */
export interface EventWorkflowDefinition<Events extends EventSchemas, Result extends JsonValue> {
  readonly meta: WorkflowMeta;
  /**
   * `import.meta.path`: where a sender finds the workflow, and which project its runs live in, the
   * nearest directory above it holding `.awf/`, whoever sends.
   */
  readonly file: string;
  readonly events: Events;
  /**
   * The events that start a run with an id that has none; any other is refused then. Absent, any event
   * starts one.
   */
  readonly starts?: readonly (keyof Events & string)[];
  run(context: EventWorkflowContext<Events>): Promise<Result>;
}
