import {
  STAGE_RECORD_VERSION,
  type StageRecord,
  type TurnRecord,
} from "@agentswf/contract/records";
import type { JsonValue } from "@agentswf/contract/workflow";
import { replaceStale, writeStageRecord } from "./runs";
import { planStage } from "./stage-plan";
import { WorkflowStopped } from "./stopped";

const STAGE_NAME = /^[a-z][a-z0-9-]*$/;

/** Why `name` can't name a stage, which is a file in the run's `stages/`; undefined when it can. */
export function stageNameProblem(name: string): string | undefined {
  return typeof name === "string" && STAGE_NAME.test(name)
    ? undefined
    : `${JSON.stringify(name)} is not a stage's name: lowercase letters, digits and '-', starting with a letter`;
}

/** A stage entered and not yet ended; it ends once, whichever end comes first. */
export type OpenStage = {
  readonly name: string;
  succeed(value: JsonValue | undefined, summary?: string): Promise<void>;
  stop(reason: string): Promise<void>;
  fail(reason: string): Promise<void>;
};

/** A stage an attempt entered, and whether it ran or was reused. */
export type StageSource = { stage: string; source: "ran" | "reused" };

/** A stage entered: reused from its record without running, or run. */
export type EnteredStage =
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
  readonly #entered: string[] = [];
  readonly #reused = new Set<string>();
  /** Whether the attempt has reached its start point, after which every stage runs. */
  #started = false;
  readonly #writes = new Set<Promise<void>>();
  #open: OpenStage | undefined;
  /** Set once the workflow's body has ended: what it left running enters no stage. */
  #sealed: string | undefined;
  /** The stop that ended the attempt; caught, it is thrown again by any later stage. */
  #stopped: WorkflowStopped | undefined;
  /** Why the attempt fails once its stop was found caught. */
  #caught: Error | undefined;

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

  /** The stages entered, in order. */
  get entered(): readonly string[] {
    return this.#entered;
  }

  /** The stages entered, in order, each run or reused. */
  get sources(): StageSource[] {
    return this.#entered.map((stage) => ({
      stage,
      source: this.#reused.has(stage) ? "reused" : "ran",
    }));
  }

  /**
   * `workflow.stop`, called in `stage` or between stages: what to throw. The first stop is kept,
   * and any later stage or stop throws it again; once it was found caught, that instead. After the
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
   * the attempt. Reaching the start point, it moves the records it outdates to `replaced/`.
   */
  async enter(
    name: string,
    misfit: (value: JsonValue | undefined) => string | undefined,
  ): Promise<EnteredStage> {
    if (this.#caught) throw this.#caught;
    if (this.#stopped) throw this.#stopped;
    this.#check(name);
    this.#entered.push(name);
    const decision = planStage(
      {
        records: this.options.records ?? new Map(),
        ...(this.options.fromStage === undefined ? {} : { fromStage: this.options.fromStage }),
        ...(this.options.workflowVersion === undefined
          ? {}
          : { workflowVersion: this.options.workflowVersion }),
        started: this.#started,
        entered: this.#entered.slice(0, -1),
      },
      name,
      misfit,
    );
    if (decision.kind === "stop") {
      this.#stopped = new WorkflowStopped(decision.reason, name);
      throw this.#stopped;
    }
    if (decision.kind === "reuse") {
      this.#reused.add(name);
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
    const stage = this.#opened(name);
    if (decision.start) {
      this.#started = true;
      await replaceStale(this.options.runDir, name, this.#reused);
    }
    return { kind: "run", stage };
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
    if (this.#entered.includes(name)) {
      throw new Error(`stage ${name} was entered twice; a loop goes inside one stage`);
    }
  }

  #opened(name: string): OpenStage {
    const now = this.options.now ?? (() => new Date());
    const started = now();
    let ended: Promise<void> | undefined;
    // A record that fails to be written fails the stage with that error, whatever its work did.
    const end = (fields: Pick<StageRecord, "outcome" | "reason" | "summary" | "value">) => {
      if (ended) return ended;
      if (this.#open === stage) this.#open = undefined;
      const record: StageRecord = {
        version: STAGE_RECORD_VERSION,
        stage: name,
        attempt: this.options.attempt,
        outcome: fields.outcome,
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        started: started.toISOString(),
        ended: now().toISOString(),
        ...(this.options.workflowVersion === undefined
          ? {}
          : { workflowVersion: this.options.workflowVersion }),
        sessions: sessionsOf(this.options.turns(), name),
        ...(fields.summary === undefined ? {} : { summary: fields.summary }),
        ...(fields.value === undefined ? {} : { value: fields.value }),
      };
      ended = writeStageRecord(this.options.runDir, record);
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
    await this.#open?.fail(this.#sealed ?? "the attempt ended");
    await Promise.all(this.#writes);
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
