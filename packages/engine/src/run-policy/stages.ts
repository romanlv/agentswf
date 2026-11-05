import type { AttemptRecord, RunView, StageLine } from "@agentswf/contract/records";

/**
 * The stage attempt `attempt` started at, which its line says with `redo`: the one `--from-stage`
 * named, or a plain run's first stage not reused. In that attempt and every later one, a stage
 * entered after `stage` whose line an earlier attempt than `attempt` wrote runs again: it was made
 * against the stage before. One never entered after the stage keeps its reuse.
 */
export type StageRedo = { stage: string; attempt: number };

/**
 * What an attempt may reuse of the run's stages, as it enters them: the engine's rule over
 * `readRun`'s view. A stage stands for its latest line, unless the redo outdated it; the plan
 * decides from that line whether it is reused, which it is only when that line succeeded: a
 * continue reuses `settled` only when it is also `last`. One per attempt, told of each line it
 * writes.
 */
export class StageReuse {
  /** Each stage's latest line, this attempt's included. */
  readonly #last: Map<string, StageLine>;
  #redo: StageRedo | undefined;
  /** Whether this attempt has entered the redo's stage, after which an older line is outdated. */
  #afterRedo = false;
  readonly #entered = new Set<string>();

  constructor(
    view: Pick<RunView, "stages" | "redo">,
    private readonly attempt: number,
  ) {
    this.#last = new Map(Object.entries(view.stages).map(([name, { last }]) => [name, last]));
    this.#redo = view.redo;
  }

  /**
   * Enters `name`: the line it stands for now, of any outcome, or undefined when it has none or the
   * redo outdated it. A stage entered already in this attempt keeps the line it had: one stage, one
   * value.
   */
  enter(name: string): StageLine | undefined {
    const line = this.#last.get(name);
    const redo = this.#redo;
    const outdated =
      redo !== undefined &&
      this.#afterRedo &&
      line !== undefined &&
      line.attempt < redo.attempt &&
      !this.#entered.has(name);
    this.#entered.add(name);
    if (name === redo?.stage) this.#afterRedo = true;
    return outdated ? undefined : line;
  }

  /** This attempt starts at `name`, entered now: a later stage with an older line runs again. */
  redoFrom(name: string): void {
    this.#redo = { stage: name, attempt: this.attempt };
    this.#afterRedo = true;
  }

  /** A line this attempt wrote, which the stages it enters from now on see. */
  wrote(line: StageLine): void {
    this.#last.set(line.name, line);
  }
}

/**
 * Each stage's latest line, in the order they started, attempt then file order breaking a tie:
 * what `--from-stage` chooses from, and what a stage not reached names.
 */
export function recordedStages(view: Pick<RunView, "stages">): StageLine[] {
  return Object.values(view.stages)
    .map(({ last }) => last)
    .sort((a, b) => a.started.localeCompare(b.started) || a.attempt - b.attempt);
}

/**
 * The stages a continue may still come to, in the order they started: each recorded stage but
 * those the redo left behind, whose latest line is older than the redo's attempt and which that
 * attempt never entered (`redoEntered`, from its attempt file), such as a stage the code no longer
 * has. Without `redoEntered`, as for a redo's attempt that crashed, none is left behind.
 */
export function upcomingStages(
  view: Pick<RunView, "stages" | "redo">,
  redoEntered: readonly string[] | undefined,
): StageLine[] {
  const { redo } = view;
  return recordedStages(view).filter(
    (line) =>
      redo === undefined ||
      redoEntered === undefined ||
      line.attempt >= redo.attempt ||
      redoEntered.includes(line.name),
  );
}

/**
 * The `--from-stage` a continue goes on with when the attempt before it was one that crashed inside
 * its start stage: it has no ending, named a `--from-stage`, and wrote no line for that stage. That
 * redo isn't in the lines, so without it the old lines would stand. Undefined otherwise. The caller
 * has already found the attempt's process gone.
 */
export function crashedRedo(
  attempts: readonly Pick<AttemptRecord, "attempt" | "ended" | "flags">[],
  view: Pick<RunView, "stages">,
): string | undefined {
  const last = attempts.at(-1);
  const stage = last?.flags.fromStage;
  if (!last || last.ended !== undefined || stage === undefined) return undefined;
  const wrote = view.stages[stage]?.history.some((line) => line.attempt === last.attempt);
  return wrote ? undefined : stage;
}
