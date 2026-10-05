import { describe, expect, test } from "bun:test";
import type { StageRecord } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
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
const values = (entries: Record<string, JsonValue>) => new Map(Object.entries(entries));
const PATH: JsonSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};
const NUMBER: JsonSchema = { type: "integer" };

describe("the stage plan, before the start point", () => {
  test("a succeeded record that fits is reused, with its value or none", () => {
    const doc = record("doc-review", { value: { path: "a" } });
    expect(planStage(state([doc]), "doc-review", PATH)).toEqual({
      kind: "reuse",
      record: doc,
      value: { path: "a" },
    });
    const notify = record("notify");
    expect(planStage(state([notify]), "notify", undefined)).toEqual({
      kind: "reuse",
      record: notify,
      value: undefined,
    });
  });

  test("a record from another major version stops", () => {
    const review = record("review", { workflowVersion: "1.4.0" });
    expect(planStage(state([review], { workflowVersion: "2.0.0" }), "review", undefined)).toEqual({
      kind: "stop",
      reason: "review was recorded by 1.4.0; this is 2.0.0",
    });
    const plan = (one: StageRecord, workflowVersion?: string) =>
      planStage(state([one], workflowVersion ? { workflowVersion } : {}), "review", undefined).kind;
    // A minor change reuses; a version on one side only leaves the schema to guard it.
    expect(plan(review, "1.5.0")).toBe("reuse");
    expect(plan(review)).toBe("reuse");
    expect(plan(record("review"), "2.0.0")).toBe("reuse");
    // Under 1.0, a minor is breaking.
    const early = record("review", { workflowVersion: "0.1.3" });
    expect(plan(early, "0.2.0")).toBe("stop");
    expect(plan(early, "0.1.9")).toBe("reuse");
  });

  test("a record that no longer fits its stage's result stops, with why", () => {
    expect(
      planStage(state([record("doc-review", { value: "a path" })]), "doc-review", PATH),
    ).toEqual({
      kind: "stop",
      reason:
        'doc-review\'s record no longer fits its result schema:\n  value: expected an object; got a string "a path"',
    });
    expect(planStage(state([record("doc-review")]), "doc-review", PATH)).toEqual({
      kind: "stop",
      reason: "doc-review's record holds no value, and the stage's result now expects one",
    });
    expect(planStage(state([record("notify", { value: 1 })]), "notify", undefined)).toEqual({
      kind: "stop",
      reason: "notify's record holds a value, and the stage no longer has a result",
    });
  });

  test("no succeeded record is the start point of a plain continue", () => {
    expect(planStage(state([]), "qa", NUMBER)).toEqual({ kind: "run", start: true });
    expect(planStage(state([record("qa", { outcome: "failed" })]), "qa", NUMBER)).toEqual({
      kind: "run",
      start: true,
    });
  });

  test("the --from-stage stage is the start point, record or not", () => {
    expect(planStage(state([record("qa")], { fromStage: "qa" }), "qa", undefined)).toEqual({
      kind: "run",
      start: true,
    });
  });
});

describe("the stage plan, before a --from-stage, for a stage with no record to reuse", () => {
  test("with nothing recorded and no value given, it needs one, naming recorded stages not reached", () => {
    const records = [record("doc-review"), record("impl")];
    expect(
      planStage(state(records, { fromStage: "qa", entered: ["doc-review"] }), "implement", NUMBER),
    ).toEqual({
      kind: "need",
      reason: "nothing recorded for implement (recorded and not reached: impl)",
      need: { stage: "implement", schema: NUMBER },
    });
  });

  test("a record that did not succeed, or can't be reused, stops to be redone, saying so", () => {
    const failed = record("implement", { outcome: "failed", attempt: 2 });
    expect(planStage(state([failed], { fromStage: "qa" }), "implement", NUMBER)).toEqual({
      kind: "stop",
      reason: "implement did not succeed in attempt 2",
    });
    const old = record("implement", { value: 1, workflowVersion: "1.0.0" });
    expect(
      planStage(state([old], { fromStage: "qa", workflowVersion: "2.0.0" }), "implement", NUMBER),
    ).toMatchObject({ kind: "stop", reason: "implement was recorded by 1.0.0; this is 2.0.0" });
  });

  test("a value given that fits is provided, in place of the record", () => {
    const given = state([record("implement", { outcome: "failed" })], {
      fromStage: "qa",
      values: values({ implement: 7 }),
    });
    expect(planStage(given, "implement", NUMBER)).toEqual({ kind: "provide", value: 7 });
  });

  test("a value given that doesn't fit still needs one, with why; over a record, it stops", () => {
    const reason =
      'implement\'s value in --values does not fit its result:\n  value: expected an integer; got a string "seven"';
    const given = { fromStage: "qa", values: values({ implement: "seven" }) };
    expect(planStage(state([], given), "implement", NUMBER)).toEqual({
      kind: "need",
      reason,
      need: { stage: "implement", schema: NUMBER },
    });
    const failed = record("implement", { outcome: "failed" });
    expect(planStage(state([failed], given), "implement", NUMBER)).toEqual({
      kind: "stop",
      reason,
    });
  });

  test("a stage that returns nothing is passed only with nothing recorded: a failed one is redone", () => {
    const failed = record("notify", { outcome: "failed" });
    expect(planStage(state([failed], { fromStage: "qa" }), "notify", undefined)).toEqual({
      kind: "stop",
      reason: "notify did not succeed in attempt 1",
    });
  });

  test("a stage that returns nothing is passed, value or not", () => {
    expect(planStage(state([], { fromStage: "qa" }), "notify", undefined)).toEqual({
      kind: "provide",
      value: undefined,
    });
  });

  test("a record that can be reused is, whatever value is given", () => {
    const doc = record("doc-review", { value: { path: "a" } });
    const given = state([doc], {
      fromStage: "qa",
      values: values({ "doc-review": { path: "b" } }),
    });
    expect(planStage(given, "doc-review", PATH)).toMatchObject({
      kind: "reuse",
      value: { path: "a" },
    });
  });
});

test("from the start point on, every stage runs", () => {
  expect(planStage(state([record("mr")], { started: true }), "mr", undefined)).toEqual({
    kind: "run",
    start: false,
  });
});
