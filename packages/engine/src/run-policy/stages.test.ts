import { describe, expect, test } from "bun:test";
import { readRun, type StageLine } from "@agentswf/contract/records";
import { crashedRedo, recordedStages, StageReuse, upcomingStages } from "./stages";

const line = (name: string, attempt: number, fields: Partial<StageLine> = {}): StageLine => ({
  kind: "stage",
  attempt,
  at: `2026-11-0${attempt}T00:00:01Z`,
  name,
  outcome: "succeeded",
  started: `2026-11-0${attempt}T00:00:00Z`,
  ...fields,
});

/** `readRun` over each attempt's claim and lines, in order. */
const viewOf = (...attempts: StageLine[][]) =>
  readRun(
    attempts.flatMap((lines, index) => [
      { kind: "claimed", attempt: index + 1, at: `2026-11-0${index + 1}T00:00:00Z` },
      ...lines,
    ]),
  );

describe("StageReuse", () => {
  test("a stage stands for its latest line, of any outcome", () => {
    const failed = line("qa", 2, { outcome: "failed" });
    const reuse = new StageReuse(viewOf([line("qa", 1)], [failed]), 3);
    expect(reuse.enter("qa")).toBe(failed);
    expect(reuse.enter("none")).toBeUndefined();
  });

  test("after the redo's stage, a line older than the redo is outdated; before it, it stands", () => {
    const view = viewOf([line("a", 1), line("b", 1), line("c", 1)], [line("b", 2, { redo: true })]);
    expect(view.redo).toEqual({ attempt: 2, stage: "b" });
    const reuse = new StageReuse(view, 3);
    expect(reuse.enter("a")?.attempt).toBe(1);
    expect(reuse.enter("b")?.attempt).toBe(2);
    expect(reuse.enter("c")).toBeUndefined();
  });

  test("a stage entered before the redo's stage keeps its line when entered again after it", () => {
    const reuse = new StageReuse(
      viewOf([line("x", 1), line("s", 1)], [line("s", 2, { redo: true })]),
      3,
    );
    expect(reuse.enter("x")?.attempt).toBe(1);
    reuse.enter("s");
    expect(reuse.enter("x")?.attempt).toBe(1);
  });

  test("a redo this attempt starts outdates what follows at once, and its own lines count", () => {
    const reuse = new StageReuse(viewOf([line("s", 1), line("x", 1)]), 2);
    reuse.enter("s");
    reuse.redoFrom("s");
    expect(reuse.enter("x")).toBeUndefined();
    const written = line("x", 2, { outcome: "failed" });
    reuse.wrote(written);
    expect(reuse.enter("x")).toBe(written);
  });
});

test("recordedStages lists each stage's latest line in the order they started", () => {
  const view = viewOf(
    [line("b", 1, { started: "2026-11-01T00:00:05Z" }), line("a", 1)],
    [line("b", 2, { outcome: "failed" })],
  );
  expect(recordedStages(view).map(({ name, attempt }) => [name, attempt])).toEqual([
    ["a", 1],
    ["b", 2],
  ]);
});

test("upcomingStages leaves out what the redo's attempt left behind, and keeps what it reused", () => {
  const at = (second: number) => `2026-11-01T00:00:0${second}Z`;
  // Attempt 2 reused a and started at b, then ran c; gone, after b in attempt 1, it never entered:
  // the code dropped it.
  const view = viewOf(
    [
      line("a", 1, { started: at(1) }),
      line("b", 1, { started: at(2) }),
      line("gone", 1, { started: at(3) }),
      line("c", 1, { started: at(4) }),
    ],
    [line("b", 2, { redo: true }), line("c", 2)],
  );
  expect(upcomingStages(view).map(({ name }) => name)).toEqual(["a", "b", "c"]);
  // A stage dropped before the redo's stage can't be told from one it reused: it is kept.
  const before = viewOf(
    [line("old", 1, { started: at(1) }), line("b", 1, { started: at(2) })],
    [line("b", 2, { redo: true })],
  );
  expect(upcomingStages(before).map(({ name }) => name)).toEqual(["old", "b"]);
  // Attempt 2 reused a and b, redid c and ran d; attempt 3 redoes b, and its code has no d. Attempt
  // 2 wrote b no line, so b's line before it says where d stood: after b, so left behind.
  const at2 = (second: number) => `2026-11-02T00:00:0${second}Z`;
  const reused = viewOf(
    [
      line("a", 1, { started: at(1) }),
      line("b", 1, { started: at(2) }),
      line("c", 1, { started: at(3), outcome: "failed" }),
    ],
    [line("c", 2, { started: at2(1), redo: true }), line("d", 2, { started: at2(2) })],
    [line("b", 3, { redo: true }), line("c", 3)],
  );
  expect(upcomingStages(reused).map(({ name }) => name)).toEqual(["a", "b", "c"]);
  // Without a redo, nothing is left out.
  expect(upcomingStages(viewOf([line("a", 1), line("b", 1)])).map(({ name }) => name)).toEqual([
    "a",
    "b",
  ]);
});

describe("crashedRedo", () => {
  const attempt = (n: number, fields: { ended?: string; fromStage?: string } = {}) => ({
    attempt: n,
    ...(fields.ended === undefined ? {} : { ended: fields.ended }),
    flags: fields.fromStage === undefined ? {} : { fromStage: fields.fromStage },
  });

  test("the --from-stage of a last attempt that ended without writing its line", () => {
    const view = viewOf([line("s", 1)], []);
    expect(crashedRedo([attempt(1), attempt(2, { fromStage: "s" })], view)).toBe("s");
  });

  test("none when it wrote the stage's line, ended, or named no stage", () => {
    const wrote = viewOf([line("s", 1)], [line("s", 2, { redo: true })]);
    expect(crashedRedo([attempt(1), attempt(2, { fromStage: "s" })], wrote)).toBeUndefined();
    const view = viewOf([line("s", 1)]);
    const ended = attempt(2, { fromStage: "s", ended: "2026-11-02T00:00:00Z" });
    expect(crashedRedo([attempt(1), ended], view)).toBeUndefined();
    expect(crashedRedo([attempt(1), attempt(2)], view)).toBeUndefined();
  });
});
