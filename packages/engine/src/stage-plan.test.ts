import { describe, expect, test } from "bun:test";
import type { StageRecord } from "@agentswf/contract/records";
import type { JsonValue } from "@agentswf/contract/workflow";
import { planStage, type StagePlanState } from "./stage-plan";

const record = (stage: string, fields: Partial<StageRecord> = {}): StageRecord => ({
  version: 1,
  stage,
  attempt: 1,
  outcome: "succeeded",
  started: "2026-10-02T16:00:00Z",
  ended: "2026-10-02T16:10:00Z",
  sessions: [],
  ...fields,
});
const state = (records: StageRecord[], fields: Partial<StagePlanState> = {}): StagePlanState => ({
  records: new Map(records.map((one) => [one.stage, one])),
  started: false,
  entered: [],
  ...fields,
});
const fits = () => undefined;
const objects = (value: JsonValue | undefined) =>
  typeof value === "object" && value !== null
    ? undefined
    : "no longer fits its result schema: expected an object";

describe("the stage plan, before the start point", () => {
  test("a succeeded record that fits is reused, with its value or none", () => {
    const doc = record("doc-review", { value: { path: "a" } });
    expect(planStage(state([doc]), "doc-review", objects)).toEqual({
      kind: "reuse",
      record: doc,
      value: { path: "a" },
    });
    const notify = record("notify");
    expect(planStage(state([notify]), "notify", fits)).toEqual({
      kind: "reuse",
      record: notify,
      value: undefined,
    });
  });

  test("a record from another major version stops, naming --from-stage", () => {
    const review = record("review", { workflowVersion: "1.4.0" });
    expect(planStage(state([review], { workflowVersion: "2.0.0" }), "review", fits)).toEqual({
      kind: "stop",
      reason: "review was recorded by 1.4.0; this is 2.0.0",
    });
    // A minor change reuses; a version on one side only leaves the schema to guard it.
    expect(planStage(state([review], { workflowVersion: "1.5.0" }), "review", fits).kind).toBe(
      "reuse",
    );
    expect(planStage(state([review]), "review", fits).kind).toBe("reuse");
    expect(
      planStage(state([record("review")], { workflowVersion: "2.0.0" }), "review", fits).kind,
    ).toBe("reuse");
    // Under 1.0, a minor is breaking.
    const early = record("review", { workflowVersion: "0.1.3" });
    expect(planStage(state([early], { workflowVersion: "0.2.0" }), "review", fits).kind).toBe(
      "stop",
    );
    expect(planStage(state([early], { workflowVersion: "0.1.9" }), "review", fits).kind).toBe(
      "reuse",
    );
  });

  test("a record that no longer fits stops, with why", () => {
    const doc = record("doc-review", { value: "a path" });
    expect(planStage(state([doc]), "doc-review", objects)).toEqual({
      kind: "stop",
      reason: "doc-review's record no longer fits its result schema: expected an object",
    });
  });

  test("no succeeded record is the start point of a plain continue", () => {
    expect(planStage(state([]), "qa", fits)).toEqual({ kind: "run", start: true });
    expect(planStage(state([record("qa", { outcome: "failed" })]), "qa", fits)).toEqual({
      kind: "run",
      start: true,
    });
  });

  test("after --from-stage, no succeeded record stops, naming recorded stages not reached", () => {
    const records = [record("doc-review"), record("impl")];
    expect(
      planStage(state(records, { fromStage: "qa", entered: ["doc-review"] }), "implement", fits),
    ).toEqual({
      kind: "stop",
      reason: "nothing recorded for implement (recorded and not reached: impl)",
    });
  });

  test("after --from-stage, a record that did not succeed stops, saying so", () => {
    const failed = record("implement", { outcome: "failed", attempt: 2 });
    expect(planStage(state([failed], { fromStage: "qa" }), "implement", fits)).toEqual({
      kind: "stop",
      reason: "implement did not succeed in attempt 2",
    });
  });

  test("the --from-stage stage is the start point, record or not", () => {
    const qa = record("qa");
    expect(planStage(state([qa], { fromStage: "qa" }), "qa", fits)).toEqual({
      kind: "run",
      start: true,
    });
  });
});

test("from the start point on, every stage runs", () => {
  expect(planStage(state([record("mr")], { started: true }), "mr", fits)).toEqual({
    kind: "run",
    start: false,
  });
});
