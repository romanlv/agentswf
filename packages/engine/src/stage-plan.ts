import type { StageNeed, StageRecord } from "@agentswf/contract/records";
import { type JsonSchema, type SchemaError, validate } from "@agentswf/contract/schema";
import type { JsonValue } from "@agentswf/contract/workflow";

/**
 * What a continue does with a stage it enters: until its start point, each is reused from its
 * record, provided, or stops the attempt; from the start point on, every stage runs. The start
 * point is `--from-stage`, or else the first stage entered with no succeeded record. Before a
 * `--from-stage`, a stage whose record can't be reused takes its value from `--values`, one that
 * returns nothing is passed, and one with nothing recorded needs a value. Pure: the records, the values, the result and the version come
 * in, a decision goes out.
 */
type StagePlanDecision =
  | { kind: "reuse"; record: StageRecord; value: JsonValue | undefined }
  /** A value given, checked by the stage's result; undefined for a stage that returns nothing. */
  | { kind: "provide"; value: JsonValue | undefined }
  /** `start` on the stage that is the start point, when the records it outdates are moved. */
  | { kind: "run"; start: boolean }
  | { kind: "stop"; reason: string }
  /** Nothing recorded, and no value given that fits: `--values` lets the attempt go on. */
  | { kind: "need"; reason: string; need: StageNeed };

export type StagePlanState = {
  records: ReadonlyMap<string, StageRecord>;
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
  const record = state.records.get(stage);
  const succeeded = record?.outcome === "succeeded" ? record : undefined;
  const stale = succeeded && unreusable(state, succeeded, result);
  if (succeeded && stale === undefined) {
    return { kind: "reuse", record: succeeded, value: succeeded.value };
  }
  if (state.fromStage === undefined) {
    return stale === undefined ? { kind: "run", start: true } : { kind: "stop", reason: stale };
  }
  // A record there that failed or went stale is redone from its stage, as on any continue, unless
  // a value given replaces it.
  const redo = record && {
    kind: "stop" as const,
    reason: stale ?? `${stage} did not succeed in attempt ${record.attempt}`,
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
 * Why a succeeded record can't be reused, as a stop says it, or undefined when it can: another
 * major version recorded it, or its value no longer fits the stage's `result`.
 */
function unreusable(
  state: StagePlanState,
  record: StageRecord,
  result: JsonSchema | undefined,
): string | undefined {
  const { stage } = record;
  const recorded = majorOf(record.workflowVersion);
  const now = majorOf(state.workflowVersion);
  if (recorded !== undefined && now !== undefined && recorded !== now) {
    return `${stage} was recorded by ${record.workflowVersion}; this is ${state.workflowVersion}`;
  }
  if (result === undefined) {
    return record.value === undefined
      ? undefined
      : `${stage}'s record holds a value, and the stage no longer has a result`;
  }
  if (record.value === undefined) {
    return `${stage}'s record holds no value, and the stage's result now expects one`;
  }
  const errors = validate(result, record.value);
  return errors.length === 0
    ? undefined
    : problems(`${stage}'s record no longer fits its result schema:`, errors);
}

/** A value's problems under what they are problems of, a line each. */
function problems(heading: string, errors: readonly SchemaError[]): string {
  return [heading, ...errors.map((error) => `  ${error.path}: ${error.message}`)].join("\n");
}

/** Recorded stages this attempt hasn't reached, which a rename in the code would leave behind. */
function unreached(state: StagePlanState, stage: string): string {
  const others = [...state.records.keys()].filter(
    (name) => name !== stage && name !== state.fromStage && !state.entered.includes(name),
  );
  return others.length > 0 ? ` (recorded and not reached: ${others.join(", ")})` : "";
}

/** What must match for a record to be reused: the major, or `0.{minor}`, as semver has it. */
function majorOf(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const [major, minor] = version.split(".");
  return major === "0" ? `0.${minor}` : major;
}
