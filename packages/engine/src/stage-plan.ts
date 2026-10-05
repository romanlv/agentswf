import type { StageNeeds, StageRecord } from "@agentswf/contract/records";
import { type JsonSchema, validate } from "@agentswf/contract/schema";
import type { JsonValue } from "@agentswf/contract/workflow";

/**
 * What a continue does with a stage it enters: until its start point, each is reused from its
 * record, provided, or stops the attempt; from the start point on, every stage runs. The start
 * point is `--from-stage`, or else the first stage entered with no succeeded record. Before a
 * `--from-stage`, a stage whose record can't be reused takes its value from `--values`, and one
 * that returns nothing is passed. Pure: the records, the values, the result and the version come
 * in, a decision goes out.
 */
type StagePlanDecision =
  | { kind: "reuse"; record: StageRecord; value: JsonValue | undefined }
  /** A value given, checked by the stage's result; undefined for a stage that returns nothing. */
  | { kind: "provide"; value: JsonValue | undefined }
  /** `start` on the stage that is the start point, when the records it outdates are moved. */
  | { kind: "run"; start: boolean }
  /** `needs` when `--values` would let the attempt go on. */
  | { kind: "stop"; reason: string; needs?: StageNeeds };

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
  if (result === undefined) return { kind: "provide", value: undefined };
  const needs = { stage, schema: result };
  const given = state.values?.get(stage);
  if (given === undefined) {
    const missing =
      stale ??
      (record
        ? `${stage} did not succeed in attempt ${record.attempt}`
        : `nothing recorded for ${stage}${unreached(state, stage)}`);
    return { kind: "stop", reason: missing, needs };
  }
  const errors = validate(result, given);
  if (errors.length > 0) {
    return {
      kind: "stop",
      reason: [
        `${stage}'s value in --values does not fit its result:`,
        ...errors.map((error) => `  ${error.path}: ${error.message}`),
      ].join("\n"),
      needs,
    };
  }
  return { kind: "provide", value: given };
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
  if (errors.length === 0) return undefined;
  return [
    `${stage}'s record no longer fits its result schema:`,
    ...errors.map((error) => `  ${error.path}: ${error.message}`),
  ].join("\n");
}

/**
 * A value its schema accepts, standing in for one not given while an attempt looks on for the
 * others it needs: the first branch, the least of each bound, required fields only.
 */
export function placeholderOf(schema: JsonSchema): JsonValue {
  if ("anyOf" in schema) return placeholderOf(schema.anyOf[0]!);
  if (!("type" in schema)) return schema.enum[0]!;
  switch (schema.type) {
    case "string":
      return schema.const ?? schema.enum?.[0] ?? "x".repeat(schema.minLength ?? 0);
    case "number":
    case "integer":
      return schema.const ?? schema.minimum ?? schema.maximum ?? 0;
    case "boolean":
      return schema.const ?? false;
    case "null":
      return null;
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => placeholderOf(schema.items));
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).flatMap((key) => {
          const property = schema.properties[key];
          return property ? [[key, placeholderOf(property)]] : [];
        }),
      );
  }
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
