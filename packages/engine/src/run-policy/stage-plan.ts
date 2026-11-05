import type { StageLine, StageNeed } from "@agentswf/contract/records";
import { type JsonSchema, type SchemaError, validate } from "@agentswf/contract/schema";
import type { JsonValue } from "@agentswf/contract/workflow";

/**
 * What a continue does with a stage it enters: until its start point, each is reused from its
 * line, provided, or stops the attempt; from the start point on, every stage runs. The start
 * point is `--from-stage`, or else the first stage entered with no succeeded line. Before a
 * `--from-stage`, a stage whose line can't be reused takes its value from `--values`, one that
 * returns nothing is passed, and one with nothing recorded needs a value. Pure: the line the run's
 * reuse gives, the values, the result and the version come in, a decision goes out.
 */
type StagePlanDecision =
  | { kind: "reuse"; line: StageLine; value: JsonValue | undefined }
  /** A value given, checked by the stage's result; undefined for a stage that returns nothing. */
  | { kind: "provide"; value: JsonValue | undefined }
  /** `start` on the stage that is the start point. */
  | { kind: "run"; start: boolean }
  | { kind: "stop"; reason: string }
  /** Nothing recorded, and no value given that fits: `--values` lets the attempt go on. */
  | { kind: "need"; reason: string; need: StageNeed };

export type StagePlanState = {
  /** The stage's line as `StageReuse` gives it: its latest, unless a redo outdated it. */
  line?: StageLine;
  /** The `meta.version` of the attempt that wrote `line`. */
  lineVersion?: string;
  /** The stages the run has a line for. */
  recorded: readonly string[];
  fromStage?: string;
  /** `--values`: each stage's value, to start at `fromStage`. */
  values?: ReadonlyMap<string, JsonValue>;
  /** The workflow's `meta.version` now. */
  workflowVersion?: string;
  /** Whether this attempt has reached its start point. */
  started: boolean;
  /** The stages this attempt has entered so far. */
  entered: readonly string[];
};

/**
 * Decides a stage entered, given its `result` as JSON Schema, absent for a stage that returns
 * nothing. A stop's reason says why; the command that goes on names the stage to redo.
 */
export function planStage(
  state: StagePlanState,
  stage: string,
  result: JsonSchema | undefined,
): StagePlanDecision {
  if (state.started) return { kind: "run", start: false };
  if (stage === state.fromStage) return { kind: "run", start: true };
  const { line } = state;
  const succeeded = line?.outcome === "succeeded" ? line : undefined;
  const stale = succeeded && unreusable(state, succeeded, result);
  if (succeeded && stale === undefined) {
    return { kind: "reuse", line: succeeded, value: succeeded.value };
  }
  if (state.fromStage === undefined) {
    return stale === undefined ? { kind: "run", start: true } : { kind: "stop", reason: stale };
  }
  // A line there that failed or went stale is redone from its stage, as on any continue, unless a
  // value given replaces it.
  const redo = line && {
    kind: "stop" as const,
    reason: stale ?? `${stage} did not succeed in attempt ${line.attempt}`,
  };
  if (result === undefined) return redo ?? { kind: "provide", value: undefined };
  const need = { stage, schema: result };
  const given = state.values?.get(stage);
  if (given !== undefined) {
    const errors = validate(result, given);
    if (errors.length === 0) return { kind: "provide", value: given };
    const misfit = problems(`${stage}'s value in --values does not fit its result:`, errors);
    return redo ? { kind: "stop", reason: misfit } : { kind: "need", reason: misfit, need };
  }
  return (
    redo ?? {
      kind: "need",
      reason: `nothing recorded for ${stage}${unreached(state, stage)}`,
      need,
    }
  );
}

/**
 * Why a succeeded line can't be reused, as a stop says it, or undefined when it can: another major
 * version wrote it, or its value no longer fits the stage's `result`.
 */
function unreusable(
  state: StagePlanState,
  line: StageLine,
  result: JsonSchema | undefined,
): string | undefined {
  const recorded = majorOf(state.lineVersion);
  const now = majorOf(state.workflowVersion);
  if (recorded !== undefined && now !== undefined && recorded !== now) {
    return `${line.name} was recorded by ${state.lineVersion}; this is ${state.workflowVersion}`;
  }
  return misfitOf(line, result);
}

/** Why a succeeded line's value no longer fits the stage's `result`; undefined when it does. */
function misfitOf(line: StageLine, result: JsonSchema | undefined): string | undefined {
  const stage = line.name;
  if (result === undefined) {
    return line.value === undefined
      ? undefined
      : `${stage}'s line holds a value, and the stage no longer has a result`;
  }
  if (line.value === undefined) {
    return `${stage}'s line holds no value, and the stage's result now expects one`;
  }
  const errors = validate(result, line.value);
  return errors.length === 0
    ? undefined
    : problems(`${stage}'s line no longer fits its result schema:`, errors);
}

/** A value's problems under what they are problems of, a line each. */
function problems(heading: string, errors: readonly SchemaError[]): string {
  return [heading, ...errors.map((error) => `  ${error.path}: ${error.message}`)].join("\n");
}

/** Recorded stages this attempt hasn't reached, which a rename in the code would leave behind. */
function unreached(state: StagePlanState, stage: string): string {
  const others = state.recorded.filter(
    (name) => name !== stage && name !== state.fromStage && !state.entered.includes(name),
  );
  return others.length > 0 ? ` (recorded and not reached: ${others.join(", ")})` : "";
}

/** What must match for a line to be reused: the major, or `0.{minor}`, as semver has it. */
function majorOf(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const [major, minor] = version.split(".");
  return major === "0" ? `0.${minor}` : major;
}

/**
 * In a run of a workflow with `events`, a stage runs once ever: a succeeded line is reused wherever
 * and however often its name is entered, whatever version of the code wrote it, as long as its
 * value still fits the stage's `result`. One that doesn't fit stops the attempt; a failed line, or
 * none, runs.
 */
export function planStageByContent(
  line: StageLine | undefined,
  result: JsonSchema | undefined,
): Extract<StagePlanDecision, { kind: "reuse" | "stop" }> | { kind: "run" } {
  if (line?.outcome !== "succeeded") return { kind: "run" };
  const misfit = misfitOf(line, result);
  return misfit === undefined
    ? { kind: "reuse", line, value: line.value }
    : { kind: "stop", reason: misfit };
}
