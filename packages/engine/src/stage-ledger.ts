import {
  STAGE_RECORD_VERSION,
  type StageRecord,
  type TurnRecord,
} from "@agentswf/contract/records";
import type { JsonValue, StageOutcome, StageSummary } from "@agentswf/contract/workflow";
import { replaceStale, stageNameProblem, writeStageRecord } from "./runs";
import { planStage } from "./stage-plan";
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
};

/** A stage entered: reused from its record without running, or run. */
type EnteredStage =
  /** `release` once the value is handed back: until then the stage counts as open. */
  | { kind: "reuse"; record: StageRecord; value: JsonValue | undefined; release(): void }
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
      now?: () => Date;
    },
  ) {}

  /** A `--from-stage` the attempt never reached: a typo, or a branch not taken. */
  get fromStageUnreached(): string | undefined {
    return this.#started ? undefined : this.options.fromStage;
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
    const upcoming = [...(this.options.records?.values() ?? [])]
      .sort((a, b) => a.started.localeCompare(b.started))
      .map((record) => record.stage)
      .filter((stage) => !this.#stages.has(stage));
    return {
      stages: [...this.#stages.values()].map(({ value: _value, ...stage }) => ({ ...stage })),
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
   * Enters `name`: reused when the plan says so, its value checked by `misfit`, or opened to run.
   * Throws why it can't be: a bad name, a second entry, another one open, or a record that stops
   * the attempt. Entered after a stop, the stop was caught, and that fails the attempt. Reaching the start point, it moves the records it outdates to `replaced/`.
   */
  async enter(
    name: string,
    misfit: (value: JsonValue | undefined) => string | undefined,
  ): Promise<EnteredStage> {
    const caught = this.caught();
    if (caught) throw caught;
    this.#check(name);
    const at = this.#now().getTime();
    const decision = planStage(
      {
        records: this.options.records ?? new Map(),
        ...(this.options.fromStage === undefined ? {} : { fromStage: this.options.fromStage }),
        ...(this.options.workflowVersion === undefined
          ? {}
          : { workflowVersion: this.options.workflowVersion }),
        started: this.#started,
        entered: [...this.#stages.keys()],
      },
      name,
      misfit,
    );
    if (decision.kind === "stop") {
      this.#stopped = new WorkflowStopped(decision.reason, name, true);
      this.#stages.set(name, {
        stage: name,
        source: "ran",
        outcome: "stopped",
        attempt: this.options.attempt,
        startedAt: at,
        endedAt: at,
      });
      throw this.#stopped;
    }
    if (decision.kind === "reuse") {
      this.#reused.add(name);
      const { attempt, summary } = decision.record;
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
      // Open until handed back, so a stage entered beside it is refused as on a fresh attempt.
      const held: OpenStage = {
        name,
        succeed: async () => undefined,
        stop: async () => undefined,
        fail: async () => undefined,
      };
      this.#open = held;
      return {
        kind: "reuse",
        record: decision.record,
        value: decision.value,
        release: () => {
          if (this.#open === held) this.#open = undefined;
        },
      };
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

  #now(): Date {
    return this.options.now?.() ?? new Date();
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
    if (this.#stages.has(name)) {
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
    this.#sealed ??= reason;
  }

  /**
   * Fails the stage still open, once what ran in it has settled, and waits for every record: none
   * is written after the attempt ends.
   */
  async close(): Promise<void> {
    this.seal("the attempt ended");
    const open = this.#open && !this.#reused.has(this.#open.name) ? this.#open.name : undefined;
    if (open !== undefined) this.#closedOpen = open;
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
