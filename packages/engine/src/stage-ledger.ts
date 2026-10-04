import {
  STAGE_RECORD_VERSION,
  type StageRecord,
  type TurnRecord,
} from "@agentswf/contract/records";
import type { JsonValue } from "@agentswf/contract/workflow";
import { writeStageRecord } from "./runs";

const STAGE_NAME = /^[a-z][a-z0-9-]*$/;

/** A stage entered and not yet ended; it ends once, whichever end comes first. */
export type OpenStage = {
  readonly name: string;
  succeed(value: JsonValue | undefined, summary?: string): Promise<void>;
  fail(reason: string): Promise<void>;
};

/**
 * One attempt's stages: which are entered, which one is open, and each one's record, written into
 * the run's `stages/` when it ends. A stage is a name entered at most once per attempt, one at a
 * time; the rest is the runner's.
 */
export class StageLedger {
  readonly #entered: string[] = [];
  readonly #writes = new Set<Promise<void>>();
  #open: OpenStage | undefined;
  /** Set once the workflow's body has ended: what it left running enters no stage. */
  #sealed: string | undefined;

  constructor(
    private readonly options: {
      runDir: string;
      attempt: number;
      workflowVersion?: string;
      /** The attempt's turns as they settled, which name the stage each ran in. */
      turns: () => readonly TurnRecord[];
      now?: () => Date;
    },
  ) {}

  /** The stages entered, in order. */
  get entered(): readonly string[] {
    return this.#entered;
  }

  /** Opens `name`, or throws why it can't be: a bad name, a second entry, or another one open. */
  enter(name: string): OpenStage {
    if (typeof name !== "string" || !STAGE_NAME.test(name)) {
      throw new Error(
        `stage ${JSON.stringify(name)}: a stage's name is lowercase letters, digits and '-', starting with a letter`,
      );
    }
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
    this.#entered.push(name);
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
