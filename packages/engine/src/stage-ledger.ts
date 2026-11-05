import type { RunView, StageLine, StageNeed } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { JsonValue, StageOutcome, StageSummary } from "@agentswf/contract/workflow";
import type { RunEventBody } from "./run-event-log";
import type { RunLines } from "./run-lines";
import { planStage, planStageByContent } from "./run-policy/stage-plan";
import { recordedStages, StageReuse, upcomingStages } from "./run-policy/stages";
import { stageNameProblem } from "./runs";
import { placeholderOf } from "./stage-schema";
import { primaryFailure, WorkflowStopped } from "./stopped";

/** A stage entered and not yet ended; it ends once, whichever end comes first. */
export type OpenStage = {
  readonly name: string;
  succeed(value: JsonValue | undefined, summary?: string): Promise<void>;
  stop(reason: string): Promise<void>;
  fail(reason: string): Promise<void>;
};

/**
 * A stage as this attempt entered it, for the view: its summary less its value, its outcome once
 * it has one, and when it began and ended here. A reused stage begins and ends as it is entered.
 */
export type StageProgress = Omit<StageSummary, "value" | "outcome" | "spanMs"> & {
  outcome?: StageOutcome;
  startedAt: number;
  endedAt?: number;
  /** When a reused stage's line was written, which the view ages. */
  recordedAt?: number;
};

/** A stage without its value, which its stage line keeps. */
export function withoutValue<Stage extends { value?: JsonValue }>(
  stage: Stage,
): Omit<Stage, "value"> {
  const { value: _value, ...rest } = stage;
  return rest;
}

/** What the ledger needs of a stage's options to enter it. */
export type StageEntry = {
  /** Its `result` as JSON Schema; absent for a stage that returns nothing. */
  result?: JsonSchema;
  /** Its one line for a value given, as its `summary` gives it. */
  summary(value: JsonValue): string | undefined;
};

/** A stage entered: reused from its line or a value given without running, or run. */
type EnteredStage =
  /** `release` once the value is handed back: until then the stage counts as open. */
  | { kind: "reuse"; value: JsonValue | undefined; release(): void }
  | { kind: "run"; stage: OpenStage };

/**
 * One attempt's stages: which are entered, which one is open, and each one's end, a `stage` line of
 * `run.jsonl`. A stage is a name entered at most once per attempt, one at a time. Until the
 * attempt's start point each is reused or stops it, as the stage plan says; the rest is the
 * runner's.
 */
export class StageLedger {
  /** Each stage entered, in order, as it stands. */
  readonly #stages = new Map<string, StageProgress & { value?: JsonValue }>();
  readonly #reused = new Set<string>();
  /** The line each stage reused from an earlier attempt was reused from. */
  readonly #reusedLines = new Map<string, StageLine>();
  /** Whether the attempt has reached its start point, after which every stage runs. */
  #started = false;
  readonly #writes = new Set<Promise<void>>();
  #open: OpenStage | undefined;
  /** Set once the workflow's body has ended: what it left running enters no stage. */
  #sealed: string | undefined;
  /** The stop that ended the attempt; a later stop throws it again. */
  #stopped: WorkflowStopped | undefined;
  /** Why the attempt fails once its stop was found caught. */
  #caught: Error | undefined;
  /** Each stage's failure as its work threw it. */
  readonly #failures = new Map<unknown, string>();
  /** The stage still open when the attempt ended. */
  #closedOpen: string | undefined;
  /** The values found missing, in order: once there is one, the attempt only looks on. */
  readonly #missing: { need: StageNeed; reason: string }[] = [];
  /**
   * Stages entered while looking on, apart from `#stages`: the view shows only the first missing,
   * as where the attempt stopped. Kept so one isn't entered twice.
   */
  readonly #looked = new Set<string>();
  #needed: WorkflowStopped | undefined;
  /** What each stage entered may reuse, this attempt's own lines included. */
  readonly #reuse: StageReuse;
  /** The run's stages as the attempt began, each by its latest line, in the order they started. */
  readonly #recorded: StageLine[];
  /** Of those, the ones a continue may still come to: none the last redo left behind. */
  readonly #upcoming: string[];
  readonly #attempt: number;

  constructor(
    private readonly options: {
      /** The attempt's writer on `run.jsonl`, which each stage's end is a line of. */
      lines: Pick<RunLines, "attempt" | "append">;
      /** `run.jsonl` as the attempt began: what a continue may reuse, and the last redo. */
      run?: Pick<RunView, "stages" | "redo">;
      /** Each earlier attempt's `meta.version`, which a line it wrote was written under. */
      versions?: ReadonlyMap<number, string>;
      /** The stages the last redo's attempt entered, from its attempt file, when it has them. */
      redoEntered?: readonly string[];
      workflowVersion?: string;
      /** `--from-stage`: the stage the attempt starts at. */
      fromStage?: string;
      /** `--values`: the values of stages before `fromStage` that have no line to reuse. */
      values?: ReadonlyMap<string, JsonValue>;
      /**
       * A run of a workflow with `events`: a stage runs once ever, reused wherever it is entered,
       * as `planStageByContent` says, and no `values`. Its start point is `fromStage` alone.
       */
      byContent?: boolean;
      /** Writes the run's event log. */
      event?(body: RunEventBody, at?: number): void;
      now?: () => Date;
    },
  ) {
    const run = options.run ?? { stages: {} };
    this.#attempt = options.lines.attempt;
    this.#reuse = new StageReuse(run, this.#attempt);
    this.#recorded = recordedStages(run);
    this.#upcoming = upcomingStages(run, options.redoEntered).map((line) => line.name);
  }

  /** The stage open now, if one is. */
  get openStage(): string | undefined {
    return this.#open?.name;
  }

  /** A `--from-stage` the attempt never reached: a typo, or a branch not taken. */
  get fromStageUnreached(): string | undefined {
    return this.#started ? undefined : this.options.fromStage;
  }

  /**
   * The run's stages as the attempt began, each by its latest line, in the order they started.
   * Before the start point nothing runs, so for an attempt that never reached it they are still the
   * run's.
   */
  get recorded(): StageLine[] {
    return this.#recorded;
  }

  /** The stop that ended the attempt, even if the workflow caught it. */
  get stopped(): WorkflowStopped | undefined {
    return this.#stopped;
  }

  /**
   * Each stage entered that has ended, in order: reused, run, or stopped by the plan as it was
   * entered, which ran nothing and wrote no line.
   */
  get summaries(): StageSummary[] {
    return [...this.#stages.values()].flatMap(
      ({ outcome, startedAt, endedAt, ...stage }): StageSummary[] =>
        outcome === undefined || endedAt === undefined
          ? []
          : [{ ...stage, outcome, spanMs: endedAt - startedAt }],
    );
  }

  /**
   * Each stage entered, as the view shows it, and those the run recorded that this attempt hasn't
   * entered yet, in the order they first started.
   */
  progress(): { stages: StageProgress[]; upcoming: string[] } {
    // By content, an earlier event's stage may never be entered again: none is upcoming.
    const upcoming = this.options.byContent
      ? []
      : this.#upcoming.filter((stage) => !this.#stages.has(stage));
    return {
      stages: [...this.#stages.values()].map((entered) => {
        const ended =
          entered.source === "reused" ? this.#reusedLines.get(entered.stage)?.at : undefined;
        const stage = withoutValue(entered);
        return ended === undefined ? stage : { ...stage, recordedAt: Date.parse(ended) };
      }),
      upcoming,
    };
  }

  /**
   * `wf.stop`, called in `stage` or between stages: what to throw. The first stop is kept,
   * and any later stop throws it again; once it was found caught, that instead. After the
   * workflow's body ended, a stop ends nothing.
   */
  stop(reason: string, stage: string | undefined): Error {
    if (this.#caught) return this.#caught;
    if (this.#sealed !== undefined) return new WorkflowStopped(reason, stage);
    // Looking on past stand-ins, the workflow's own checks see values no one gave.
    const needed = this.#stopForNeeded();
    if (needed) return needed;
    this.#stopped ??= new WorkflowStopped(reason, stage);
    return this.#stopped;
  }

  /** The stop was caught and the workflow went on: from now on, that is what fails the attempt. */
  caught(): Error | undefined {
    if (this.#stopped) {
      this.#caught ??= new Error(`stop was caught: ${this.#stopped.reason}`, {
        cause: this.#stopped,
      });
    }
    return this.#caught;
  }

  /**
   * Enters `name`: reused or provided when the plan says so, or opened to run. A value provided is
   * written as its line before it is handed back. Throws why it can't be: a bad name, a second
   * entry, another one open, or a line that stops the attempt. Entered after a stop, the stop was
   * caught, and that fails the attempt.
   */
  async enter(name: string, entry: StageEntry): Promise<EnteredStage> {
    // Looking on, a stop caught is the one for the values missing, which ends the attempt anyway.
    const caught = this.#missing.length > 0 ? undefined : this.caught();
    if (caught) throw caught;
    this.#check(name);
    const at = this.#now().getTime();
    if (this.options.byContent) return this.#enterByContent(name, entry, at);
    const line = this.#reuse.enter(name);
    const lineVersion = line && this.options.versions?.get(line.attempt);
    const decision = planStage(
      {
        ...(line === undefined ? {} : { line }),
        ...(lineVersion === undefined ? {} : { lineVersion }),
        recorded: this.#recorded.map((each) => each.name),
        ...(this.options.fromStage === undefined ? {} : { fromStage: this.options.fromStage }),
        ...(this.options.values === undefined ? {} : { values: this.options.values }),
        ...(this.options.workflowVersion === undefined
          ? {}
          : { workflowVersion: this.options.workflowVersion }),
        started: this.#started,
        entered: [...this.#stages.keys()],
      },
      name,
      entry.result,
    );
    if (this.#missing.length > 0) {
      // Looking on for the other values the start point needs: nothing runs or is recorded on
      // disk, and anything else ends the attempt with what was found.
      this.#looked.add(name);
      if (decision.kind === "need") {
        this.#missing.push({ need: decision.need, reason: decision.reason });
        return this.#hold(name, placeholderOf(decision.need.schema));
      }
      if (decision.kind === "reuse" || decision.kind === "provide") {
        return this.#hold(name, decision.value);
      }
      throw this.#stopForNeeded();
    }
    if (decision.kind === "need") {
      // The attempt stops for it once it has looked on, past a stand-in its schema accepts, for
      // the other values the start point needs.
      this.#missing.push({ need: decision.need, reason: decision.reason });
      this.#stoppedAt(name, at);
      return this.#hold(name, placeholderOf(decision.need.schema));
    }
    if (decision.kind === "stop") {
      this.#stopped = new WorkflowStopped(decision.reason, name, true);
      this.#stoppedAt(name, at);
      throw this.#stopped;
    }
    if (decision.kind === "reuse" || decision.kind === "provide") {
      const held = this.#hold(name, decision.value);
      let line: StageLine;
      if (decision.kind === "reuse") line = decision.line;
      else {
        const written = this.#provide(name, decision.value, entry, at);
        // Its failure is the stage's, thrown below.
        this.#writes.add(
          written.then(
            () => undefined,
            () => undefined,
          ),
        );
        try {
          line = await written;
        } catch (error) {
          held.release();
          throw error;
        }
      }
      this.#reused.add(name);
      if (decision.kind === "reuse") this.#reusedLines.set(name, line);
      this.options.event?.(
        {
          kind: "stage-ended",
          stage: name,
          outcome: "succeeded",
          source: decision.kind === "reuse" ? "reused" : "provided",
        },
        at,
      );
      const { attempt, summary, provided } = line;
      this.#stages.set(name, {
        stage: name,
        source: "reused",
        outcome: "succeeded",
        attempt,
        startedAt: at,
        endedAt: at,
        ...(summary === undefined ? {} : { summary }),
        ...(decision.value === undefined ? {} : { value: decision.value }),
        ...(provided ? { provided } : {}),
      });
      return held;
    }
    if (decision.start) {
      this.#started = true;
      this.#reuse.redoFrom(name);
    }
    return { kind: "run", stage: this.#opened(name, at, decision.start) };
  }

  /**
   * Enters a stage by content: reused from its succeeded line, this attempt's included, run when it
   * has none or a failed one. After the redo's stage in this attempt, a line older than the redo is
   * outdated and runs again: see `StageRedo`.
   */
  async #enterByContent(name: string, entry: StageEntry, at: number): Promise<EnteredStage> {
    if (!this.#started && name === this.options.fromStage) return this.#startByContent(name, at);
    const decision = planStageByContent(this.#reuse.enter(name), entry.result);
    if (decision.kind === "stop") {
      this.#stopped = new WorkflowStopped(decision.reason, name, true);
      this.#stoppedAt(name, at);
      throw this.#stopped;
    }
    if (decision.kind === "reuse") {
      const held = this.#hold(name, decision.value);
      this.#reused.add(name);
      // Entered again in the attempt that ran or reused it: nothing more to show or log.
      if (this.#stages.get(name)?.outcome === "succeeded") return held;
      this.#reusedLines.set(name, decision.line);
      const { attempt, summary } = decision.line;
      this.options.event?.(
        { kind: "stage-ended", stage: name, outcome: "succeeded", source: "reused" },
        at,
      );
      this.#stages.set(name, {
        stage: name,
        source: "reused",
        outcome: "succeeded",
        attempt,
        startedAt: at,
        endedAt: at,
        ...(summary === undefined ? {} : { summary }),
        ...(decision.value === undefined ? {} : { value: decision.value }),
      });
      return held;
    }
    return { kind: "run", stage: this.#opened(name, at) };
  }

  /**
   * `--from-stage` reached by content: it runs, and this attempt is the redo, which its line says.
   * An attempt that dies while it runs writes no line, so the old one stands and the redo, which
   * nothing then shows, is issued again. The stages after it rerun as they are entered, not all at
   * once: one never entered keeps its line.
   */
  #startByContent(name: string, at: number): EnteredStage {
    this.#reuse.enter(name);
    this.#reuse.redoFrom(name);
    this.#started = true;
    return { kind: "run", stage: this.#opened(name, at, true) };
  }

  /** A stage the plan stopped as it was entered: shown stopped, though it ran nothing. */
  #stoppedAt(name: string, at: number): void {
    this.options.event?.({ kind: "stage-ended", stage: name, outcome: "stopped" }, at);
    this.#stages.set(name, {
      stage: name,
      source: "ran",
      outcome: "stopped",
      attempt: this.#attempt,
      startedAt: at,
      endedAt: at,
    });
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** A stage handed back without running, open until it is, so none is entered beside it. */
  #hold(name: string, value: JsonValue | undefined): Extract<EnteredStage, { kind: "reuse" }> {
    const held: OpenStage = {
      name,
      succeed: async () => undefined,
      stop: async () => undefined,
      fail: async () => undefined,
    };
    this.#open = held;
    return {
      kind: "reuse",
      value,
      release: () => {
        if (this.#open === held) this.#open = undefined;
      },
    };
  }

  /**
   * The stop for every value the attempt found missing, at the first stage's, in the order
   * reached, which is from now on the attempt's stop; undefined when none was. Its reason is the
   * first's, and any value given that didn't fit.
   */
  #stopForNeeded(): WorkflowStopped | undefined {
    const [first, ...more] = this.#missing;
    if (!first) return undefined;
    // Built again as the look finds more: a stop thrown and caught earlier named fewer.
    if (this.#needed?.needs?.length !== this.#missing.length) {
      const given = more.filter(({ need }) => this.options.values?.has(need.stage));
      this.#needed = new WorkflowStopped(
        [first.reason, ...given.map(({ reason }) => reason)].join("\n"),
        first.need.stage,
        false,
        this.#missing.map(({ need }) => need),
      );
      this.#stopped = this.#needed;
    }
    return this.#needed;
  }

  /**
   * Before a turn, compaction, decision or sandbox starts: while the attempt looks on for missing
   * values, past stand-ins, none may, and the attempt stops with what it found.
   */
  checkOperation(): void {
    const needed = this.#stopForNeeded();
    if (needed) throw needed;
  }

  /**
   * What the attempt ends with, given how its body did: past stand-ins, what it went on to do,
   * return or throw, isn't its own, and it stops for the values it found missing, unless it was
   * `interrupted`, cancelled or out of time. Undefined for a body that returned on its own.
   */
  settle(failure: unknown, interrupted: boolean): unknown {
    return (interrupted ? undefined : this.#stopForNeeded()) ?? failure;
  }

  /** Writes a value given for a stage, or none for one that returns nothing: no turn ran it. */
  async #provide(
    name: string,
    value: JsonValue | undefined,
    entry: StageEntry,
    at: number,
  ): Promise<StageLine> {
    const time = new Date(at).toISOString();
    const summary = value === undefined ? undefined : entry.summary(value);
    const line: StageLine = {
      kind: "stage",
      attempt: this.#attempt,
      at: time,
      name,
      outcome: "succeeded",
      started: time,
      ...(summary === undefined ? {} : { summary }),
      ...(value === undefined ? {} : { value }),
      provided: true,
    };
    await this.options.lines.append(line);
    this.#reuse.wrote(line);
    return line;
  }

  #check(name: string): void {
    const problem = stageNameProblem(name);
    if (problem) throw new Error(`stage ${problem}`);
    if (this.#sealed !== undefined) {
      throw new Error(`stage ${name} was entered after the workflow ended: ${this.#sealed}`);
    }
    if (this.#open) {
      throw new Error(
        `stage ${name} was entered while stage ${this.#open.name} is open; one stage runs at a time, and parallel work goes inside one`,
      );
    }
    if (!this.options.byContent && (this.#stages.has(name) || this.#looked.has(name))) {
      throw new Error(`stage ${name} was entered twice; a loop goes inside one stage`);
    }
  }

  /**
   * Opens `name` to run, from `startedAt`, the one clock read its line's `started` and the log's
   * `stage-started` both carry, which `awf runs` pairs them by. `redo` on the stage the attempt
   * started at.
   */
  #opened(name: string, startedAt: number, redo = false): OpenStage {
    const entered: StageProgress & { value?: JsonValue } = {
      stage: name,
      source: "ran",
      attempt: this.#attempt,
      startedAt,
    };
    this.#stages.set(name, entered);
    this.options.event?.({ kind: "stage-started", stage: name }, startedAt);
    let ended: Promise<void> | undefined;
    // A line that fails to be written fails the stage with that error, whatever its work did.
    const end = (fields: Pick<StageLine, "outcome" | "reason" | "summary" | "value">) => {
      if (ended) return ended;
      if (this.#open === stage) this.#open = undefined;
      const at = this.#now();
      const line: StageLine = {
        kind: "stage",
        attempt: this.#attempt,
        at: at.toISOString(),
        name,
        outcome: fields.outcome,
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        started: new Date(startedAt).toISOString(),
        ...(fields.summary === undefined ? {} : { summary: fields.summary }),
        ...(fields.value === undefined ? {} : { value: fields.value }),
        ...(redo ? { redo: true as const } : {}),
      };
      Object.assign(entered, {
        outcome: line.outcome,
        endedAt: at.getTime(),
        ...(line.summary === undefined ? {} : { summary: line.summary }),
        ...(line.value === undefined ? {} : { value: line.value }),
      });
      ended = this.options.lines.append(line).then(
        () => this.#reuse.wrote(line),
        (error: unknown) => {
          entered.outcome = "failed";
          throw error;
        },
      );
      // Its outcome once the line is written: one that is not fails the stage.
      const logEnd = () =>
        this.options.event?.(
          { kind: "stage-ended", stage: name, outcome: entered.outcome ?? line.outcome },
          at.getTime(),
        );
      ended.then(logEnd, logEnd);
      this.#writes.add(ended);
      return ended;
    };
    const stage: OpenStage = {
      name,
      succeed: (value, summary) =>
        end({
          outcome: "succeeded",
          ...(summary === undefined ? {} : { summary }),
          ...(value === undefined ? {} : { value }),
        }),
      stop: (reason) => end({ outcome: "stopped", reason }),
      fail: (reason) => end({ outcome: "failed", reason }),
    };
    this.#open = stage;
    return stage;
  }

  /**
   * Leaves the open stage `name` unended and without a line, as the run parked at a wait in it: the
   * next attempt runs it again.
   */
  abandon(name: string): void {
    if (this.#open?.name !== name) return;
    this.#open = undefined;
    this.#stages.delete(name);
  }

  /** Once the workflow's body has ended, why: no stage is entered after it. */
  seal(reason: string): void {
    if (this.#sealed !== undefined) return;
    this.#sealed = reason;
    // Cancellation settles the stage's own work after the body ended: the stage open now is where.
    if (this.#open && !this.#reused.has(this.#open.name)) this.#closedOpen = this.#open.name;
  }

  /**
   * Fails the stage still open, once what ran in it has settled, and waits for every line: none is
   * written after the attempt ends.
   */
  async close(): Promise<void> {
    this.seal("the attempt ended");
    const failing = this.#open?.fail(this.#sealed ?? "the attempt ended");
    // Every other write's failure was its stage's, and reported there.
    await Promise.allSettled(this.#writes);
    await failing;
  }

  /** A stage's failure, as its work threw it: the attempt ends in that stage if it escapes. */
  failedIn(stage: string, error: unknown): void {
    this.#failures.set(error, stage);
  }

  /**
   * The stage an attempt that didn't complete ended in: the one its failure escaped from, or the
   * one still open when it ended. Undefined when it ended between stages.
   */
  endedIn(failure: unknown): string | undefined {
    const first = primaryFailure(failure);
    if (first instanceof WorkflowStopped) return first.stage;
    return this.#failures.get(first) ?? this.#closedOpen;
  }
}
