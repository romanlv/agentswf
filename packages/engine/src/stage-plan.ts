import type { StageRecord } from "@agentswf/contract/records";
import type { JsonValue } from "@agentswf/contract/workflow";

/**
 * What a continue does with a stage it enters: until its start point, each is reused from its
 * record or stops the attempt; from the start point on, every stage runs. The start point is
 * `--from-stage`, or else the first stage entered with no succeeded record. Pure: the records, the
 * value check and the version come in, a decision goes out.
 */
export type StagePlanDecision =
  | { kind: "reuse"; record: StageRecord; value: JsonValue | undefined }
  /** `start` on the stage that is the start point, when the records it outdates are moved. */
  | { kind: "run"; start: boolean }
  | { kind: "stop"; reason: string };

export type StagePlanState = {
  records: ReadonlyMap<string, StageRecord>;
  fromStage?: string;
  /** The workflow's `meta.version` now. */
  workflowVersion?: string;
  /** Whether this attempt has reached its start point. */
  started: boolean;
  /** The stages this attempt has entered so far. */
  entered: readonly string[];
};

/**
 * Decides a stage entered. `check` says why a recorded value no longer fits the stage's `result`,
 * or undefined when it does.
 */
export function planStage(
  state: StagePlanState,
  stage: string,
  check: (value: JsonValue | undefined) => string | undefined,
): StagePlanDecision {
  if (state.started) return { kind: "run", start: false };
  if (stage === state.fromStage) return { kind: "run", start: true };
  const record = state.records.get(stage);
  if (record?.outcome !== "succeeded") {
    if (state.fromStage === undefined) return { kind: "run", start: true };
    const missing = record
      ? `${stage} did not succeed in attempt ${record.attempt}`
      : `nothing recorded for ${stage}${unreached(state, stage)}`;
    return { kind: "stop", reason: `${missing}; --from-stage ${stage}` };
  }
  const recorded = majorOf(record.workflowVersion);
  const now = majorOf(state.workflowVersion);
  if (recorded !== undefined && now !== undefined && recorded !== now) {
    return {
      kind: "stop",
      reason: `${stage} was recorded by ${record.workflowVersion}; this is ${state.workflowVersion}; --from-stage ${stage}`,
    };
  }
  const misfit = check(record.value);
  if (misfit !== undefined) {
    return {
      kind: "stop",
      reason: `${stage}'s record no longer fits: ${misfit}; --from-stage ${stage}`,
    };
  }
  return { kind: "reuse", record, value: record.value };
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
