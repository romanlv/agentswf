import type { AgentDirectory, HarnessKind, OperationRecord } from "./agents";
import type { HarnessAllowance } from "./allowance";
import type { DecisionDirectory } from "./decisions";
import type {
  EmitOptions,
  EmitOutcome,
  EventSchemas,
  OutputOf,
  OwnEvent,
  OwnEventOf,
  ReceivedEvent,
} from "./events";
import type { Workflow } from "./executable";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { Messaging } from "./messaging";
import type { CodeParticipantDirectory } from "./participants";
import type { SandboxDirectory } from "./sandboxes";
import type { AbsoluteDeadline } from "./timing";
import type {
  Branches,
  Checked,
  Duration,
  Next,
  RaceBranches,
  RaceChecked,
  Signal,
  Timeout,
  TimeRead,
  Timer,
  WaitOptions,
  When,
} from "./waits";

export type WorkflowRunId = string;

export interface WorkflowMeta {
  /** What its runs are kept under; a file may move or be copied and stay the same workflow. */
  name: string;
  description: string;
  /** @deprecated Drop it: nothing reads it. */
  whenToUse?: string;
  /** Semver, recorded with each attempt. */
  version?: string;
}

export interface ParallelOptions {
  /** Bounds every item, within the stage, `parallel` and run around it. */
  timeout?: Timeout;
  /** @deprecated Give `timeout`: a `Date`, or a `Duration` such as `"20m"`. */
  deadline?: AbsoluteDeadline;
  /** Positive integer local maximum; global admission may reduce it. */
  concurrency?: number;
  label?: string;
}

/**
 * A stage's end: `stopped` is `wf.stop` inside it; `failed` covers a throw, a value its
 * schema rejects, and a cancellation.
 */
export type StageOutcome = "succeeded" | "stopped" | "failed";

export interface StageOptions<T extends JsonValue> {
  /** Checks the value when the stage records it, and whenever a continue reuses it. */
  result: OutputSchema<T>;
  /** One line about the value, for the view and the record. */
  summary?: (value: T) => string;
}

/**
 * What a workflow's `run` is given. `Events` is what it declares in `events`: the names `signal`,
 * `started` and `receive` know. A workflow's own `run` gets its events, or `NoEvents`; bare,
 * `WorkflowContext` is any workflow's, for a helper that takes whichever it is passed, where
 * `signal` checks its name when it runs. Every run can wait, race, select and sleep; a run of
 * a workflow with `events` is also named by whoever starts it or sends to it, and waiting with no
 * turn running and nothing unacknowledged it parks: its process exits, and the next event continues
 * it from the top, so what must outlive that lives in files or a stage. A run without events never
 * parks: it waits in its process.
 */
// biome-ignore lint/suspicious/noExplicitAny: bare, it is any workflow's context; a context is typed by its own events, which make none another's.
export interface WorkflowContext<Events extends EventSchemas = any> {
  /** The run's id, the same in every attempt of it. */
  readonly runId: WorkflowRunId;
  /** Which `awf run` of the run this is: 1, then one more for each continue. */
  readonly attempt: number;
  /** Working directory and hard bound for this invocation, supplied and enforced by the engine. */
  readonly cwd: string;
  /** The run's deadline; absent when it has none, as it has unless `awf run --timeout` sets one. */
  readonly deadline?: Date & {
    /** @deprecated `wf.deadline` is a `Date`: read `wf.deadline.getTime()`. */
    readonly unixMilliseconds: number;
  };
  readonly agents: AgentDirectory;
  readonly sandboxes: SandboxDirectory;
  /** Closed questions to a decision model: probabilities back in a few hundred milliseconds. */
  readonly decisions: DecisionDirectory;
  /** Participants outside the run; one routed to the code needs a workflow with `events`. */
  readonly participants: CodeParticipantDirectory;
  readonly messages: Messaging;
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
  /**
   * A stage around a wait, `stage(name, () => wf.receive(…))`, returns the batch that wait took,
   * then and on every rerun. Its work is the wait alone.
   *
   * @deprecated Wait with `wf.race(…)`, which is recorded under its name, outside a stage.
   */
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
   * Ends the attempt `stopped`, apart from failed: in the stage it is called from, which a continue
   * then redoes, or between stages, where a continue checks again. Caught, it fails the stage that
   * caught it, or the attempt when the workflow returns. `return wf.stop(…)` narrows where a
   * bare call doesn't.
   */
  stop(reason: string): never;

  /**
   * Sends an event to the run of the workflow `target` whose id is `run`: the run starts if it has
   * none and the event is one that starts one, and is woken if it has one. A name `target`
   * doesn't declare, or data its schema refuses, throws; the run's state is the outcome.
   */
  emit<Target extends EventSchemas, Name extends keyof Target & string>(
    target: Workflow<JsonValue, JsonValue, Target>,
    run: string,
    name: Name,
    data: OutputOf<Target[Name]>,
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

  /**
   * Waits until `when`, a duration from the first call under `name` or a time, and goes on. The
   * time is recorded under `name` the first time, so a rerun waits for what is left of it, and
   * returns at once once it has passed.
   */
  sleep(name: string, when: When): Promise<void>;

  /** The run's time: the clock's in a run, the virtual clock's in a test. Read it, not `Date.now()`. */
  now(): Date;

  /**
   * Acknowledges what the last call returned, then waits for events not yet acknowledged and
   * returns them in arrival order: the first call of a run takes the event that started it, if one did. After
   * a crash, the first call returns the batch taken and not acknowledged, alone. In a stage, it
   * returns the stage's recorded batch on a rerun.
   */
  receive(options?: WaitOptions): Promise<ReceivedEvent<Events>[]>;

  /**
   * Waits for the first of `branches` and returns it under its branch's name, recorded under
   * `name`, so a rerun gets the same answer back. It takes only what it names: the rest stays in
   * the mailbox for a later wait, and doesn't wake a run parked here. Of two ready, the earlier
   * wins. A duration as a branch is a timer of the race's own, `{name}@{branch}`, cancelled when
   * another branch wins; a `wf.timer()` passed in is the code's to cancel.
   */
  race<B extends RaceBranches>(
    name: string,
    branches: RaceChecked<B>,
    options?: WaitOptions,
  ): Promise<Next<B>>;

  /**
   * A loop over the events `branches` take, one at a time, each under its branch's name, until the
   * loop returns or breaks. An event is acknowledged when the loop asks for the next; after a crash,
   * the one taken and not acknowledged comes back once. What no branch names stays in the mailbox.
   */
  select<B extends Branches>(branches: Checked<B>, options?: WaitOptions): AsyncIterable<Next<B>>;

  /**
   * A timer, recorded the first time `name` is called: due `when`, a duration from then or a time.
   * A later call gets the recorded timer; one asking another time is logged and ignored. Its name
   * has no `@`, which a race's own timers use.
   */
  timer(name: string, when: When): Timer;

  /**
   * A select's branch due at the time `read` returns from the run's state, or never for `null`;
   * read at each wait, so it follows the state as it moves. Not a timer: nothing is recorded, and
   * events ready at the wait come first. A time returned once isn't returned again by a branch of
   * this name. `read` is cheap and synchronous, and its state outlives the process: in files, or
   * rebuilt from them, as a parked run reads it again in a new one.
   */
  at(read: () => Date | null): TimeRead;

  /**
   * `now()` plus `duration`: a time for the run's state to keep, as `wf.at` reads it. Kept
   * where it is written, it doesn't move on a rerun; made at a read, it would never come due.
   */
  after(duration: Duration): Date;

  /** One of the workflow's declared events, as a source. */
  signal<Name extends keyof Events & string>(name: Name): Signal<OwnEventOf<Events, Name>>;

  /** The event that started the run; absent for a run started by hand. Typed by `events`, not `starts`. */
  readonly started?: OwnEvent<Events>;
}

/** @deprecated Use `WorkflowContext<Events>`: every workflow has one context. */
export type EventWorkflowContext<Events extends EventSchemas> = WorkflowContext<Events>;
