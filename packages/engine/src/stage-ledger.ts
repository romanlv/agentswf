import {
  STAGE_RECORD_VERSION,
  type StageNeed,
  type StageRecord,
  type TurnRecord,
} from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { JsonValue, StageOutcome, StageSummary } from "@agentswf/contract/workflow";
import { replaceRecord, replaceStale, stageNameProblem, writeStageRecord } from "./runs";
import { planStage } from "./stage-plan";
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
  /** When a reused stage's record ended, which the view ages. */
  recordedAt?: number;
};

/** A stage without its value, which its stage record keeps. */
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

/** A stage entered: reused from its record or a value given without running, or run. */
type EnteredStage =
  /** `release` once the value is handed back: until then the stage counts as open. */
  | { kind: "reuse"; value: JsonValue | undefined; release(): void }
  | { kind: "run"; stage: OpenStage };

/**
 * One attempt's stages: which are entered, which one is open, and each one's record, written into
 * the run's `stages/` when it ends. A stage is a name entered at most once per attempt, one at a
 * time. Until the attempt's start point each is reused or stops it, as the stage plan says; the
 * rest is the runner's.
 */
export class StageLedger {
  /** Each stage entered, in order, as it stands. */
  readonly #stages = new Map<string, StageProgress & { value?: JsonValue }>();
  readonly #reused = new Set<string>();
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

  constructor(
    private readonly options: {
      runDir: string;
      attempt: number;
      workflowVersion?: string;
      /** The attempt's turns as they settled, which name the stage each ran in. */
      turns: () => readonly TurnRecord[];
      /** The run's stage records as the attempt began: what a continue may reuse. */
      records?: ReadonlyMap<string, StageRecord>;
      /** `--from-stage`: the stage the attempt starts at. */
      fromStage?: string;
      /** `--values`: the values of stages before `fromStage` that have no record to reuse. */
      values?: ReadonlyMap<string, JsonValue>;
      now?: () => Date;
    },
  ) {}

  /** A `--from-stage` the attempt never reached: a typo, or a branch not taken. */
  get fromStageUnreached(): string | undefined {
    return this.#started ? undefined : this.options.fromStage;
  }

  /**
   * The run's stage records as the attempt began, in the order they started. Before the start
   * point nothing runs, so for an attempt that never reached it they are still the run's.
   */
  get recorded(): StageRecord[] {
    return [...(this.options.records?.values() ?? [])].sort((a, b) =>
      a.started.localeCompare(b.started),
    );
  }

  /** The stop that ended the attempt, even if the workflow caught it. */
  get stopped(): WorkflowStopped | undefined {
    return this.#stopped;
  }

  /**
   * Each stage entered that has ended, in order: reused, run, or stopped by the plan as it was
   * entered, which ran nothing and has no record.
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
    const upcoming = this.recorded
      .map((record) => record.stage)
      .filter((stage) => !this.#stages.has(stage));
    const recorded = (stage: string) => this.options.records?.get(stage)?.ended;
    return {
      stages: [...this.#stages.values()].map((entered) => {
        const ended = entered.source === "reused" ? recorded(entered.stage) : undefined;
        const stage = withoutValue(entered);
        return ended === undefined ? stage : { ...stage, recordedAt: Date.parse(ended) };
      }),
      upcoming,
    };
  }

  /**
   * `workflow.stop`, called in `stage` or between stages: what to throw. The first stop is kept,
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
   * recorded before it is handed back. Throws why it can't be: a bad name, a second entry, another
   * one open, or a record that stops the attempt. Entered after a stop, the stop was caught, and
   * that fails the attempt. Reaching the start point, it moves the records it outdates to
   * `replaced/`.
   */
  async enter(name: string, entry: StageEntry): Promise<EnteredStage> {
    // Looking on, a stop caught is the one for the values missing, which ends the attempt anyway.
    const caught = this.#missing.length > 0 ? undefined : this.caught();
    if (caught) throw caught;
    this.#check(name);
    const at = this.#now().getTime();
    const decision = planStage(
      {
        records: this.options.records ?? new Map(),
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
      let record: StageRecord;
      if (decision.kind === "reuse") record = decision.record;
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
          record = await written;
        } catch (error) {
          held.release();
          throw error;
        }
      }
      this.#reused.add(name);
      const { attempt, summary, provided } = record;
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
    // Open while the records it outdates are moved, so no other stage enters beside it.
    const stage = this.#opened(name, at);
    if (decision.start) {
      try {
        await replaceStale(this.options.runDir, name, this.#reused);
      } catch (error) {
        // Not entered after all: nothing ran, so nothing is recorded, and no stage is left open.
        this.#stages.delete(name);
        this.#open = undefined;
        throw error;
      }
      this.#started = true;
    }
    return { kind: "run", stage };
  }

  /** A stage the plan stopped as it was entered: shown stopped, though it ran nothing. */
  #stoppedAt(name: string, at: number): void {
    this.#stages.set(name, {
      stage: name,
      source: "ran",
      outcome: "stopped",
      attempt: this.options.attempt,
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

  /** Records a value given for a stage, or none for one that returns nothing: no turn ran it. */
  async #provide(
    name: string,
    value: JsonValue | undefined,
    entry: StageEntry,
    at: number,
  ): Promise<StageRecord> {
    const time = new Date(at).toISOString();
    const summary = value === undefined ? undefined : entry.summary(value);
    const record: StageRecord = {
      version: STAGE_RECORD_VERSION,
      stage: name,
      attempt: this.options.attempt,
      outcome: "succeeded",
      started: time,
      ended: time,
      ...(this.options.workflowVersion === undefined
        ? {}
        : { workflowVersion: this.options.workflowVersion }),
      sessions: [],
      ...(summary === undefined ? {} : { summary }),
      ...(value === undefined ? {} : { value }),
      provided: true,
    };
    // A record it replaces, one that failed or went stale, is kept as a redone stage's is.
    if (this.options.records?.has(name)) await replaceRecord(this.options.runDir, name);
    await writeStageRecord(this.options.runDir, record);
    return record;
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
    if (this.#stages.has(name) || this.#looked.has(name)) {
      throw new Error(`stage ${name} was entered twice; a loop goes inside one stage`);
    }
  }

  #opened(name: string, startedAt: number): OpenStage {
    const entered: StageProgress & { value?: JsonValue } = {
      stage: name,
      source: "ran",
      attempt: this.options.attempt,
      startedAt,
    };
    this.#stages.set(name, entered);
    let ended: Promise<void> | undefined;
    // A record that fails to be written fails the stage with that error, whatever its work did.
    const end = (fields: Pick<StageRecord, "outcome" | "reason" | "summary" | "value">) => {
      if (ended) return ended;
      if (this.#open === stage) this.#open = undefined;
      const at = this.#now();
      const record: StageRecord = {
        version: STAGE_RECORD_VERSION,
        stage: name,
        attempt: this.options.attempt,
        outcome: fields.outcome,
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        started: new Date(startedAt).toISOString(),
        ended: at.toISOString(),
        ...(this.options.workflowVersion === undefined
          ? {}
          : { workflowVersion: this.options.workflowVersion }),
        sessions: sessionsOf(this.options.turns(), name),
        ...(fields.summary === undefined ? {} : { summary: fields.summary }),
        ...(fields.value === undefined ? {} : { value: fields.value }),
      };
      Object.assign(entered, {
        outcome: record.outcome,
        endedAt: at.getTime(),
        ...(record.summary === undefined ? {} : { summary: record.summary }),
        ...(record.value === undefined ? {} : { value: record.value }),
      });
      ended = writeStageRecord(this.options.runDir, record).then(
        () => undefined,
        (error: unknown) => {
          entered.outcome = "failed";
          throw error;
        },
      );
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

  /** Once the workflow's body has ended, why: no stage is entered after it. */
  seal(reason: string): void {
    if (this.#sealed !== undefined) return;
    this.#sealed = reason;
    // Cancellation settles the stage's own work after the body ended: the stage open now is where.
    if (this.#open && !this.#reused.has(this.#open.name)) this.#closedOpen = this.#open.name;
  }

  /**
   * Fails the stage still open, once what ran in it has settled, and waits for every record: none
   * is written after the attempt ends.
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

/** The session each of the stage's turns ran on, once per agent and session. */
function sessionsOf(turns: readonly TurnRecord[], stage: string): StageRecord["sessions"] {
  const seen = new Map<string, StageRecord["sessions"][number]>();
  for (const turn of turns) {
    const session = turn.sessions.at(-1);
    if (turn.stage !== stage || !session) continue;
    const key = `${turn.agent}\0${session.harness}\0${session.id}`;
    if (!seen.has(key)) {
      seen.set(key, { agent: turn.agent, harness: session.harness, session: session.id });
    }
  }
  return [...seen.values()];
}
