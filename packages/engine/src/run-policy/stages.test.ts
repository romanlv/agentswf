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
  // Attempt 2 reused a and started at b; c it ran; gone it never entered: the code dropped it.
  const view = viewOf(
    [line("a", 1), line("gone", 1), line("b", 1), line("c", 1)],
    [line("b", 2, { redo: true }), line("c", 2)],
  );
  const names = (entered?: string[]) => upcomingStages(view, entered).map(({ name }) => name);
  expect(names(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  // A redo's attempt that crashed left no list: nothing is left out.
  expect(names()).toEqual(["a", "gone", "b", "c"]);
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
