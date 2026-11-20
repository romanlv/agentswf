import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabelRecord } from "../format/records";
import { comparedTrial } from "./compare";
import { agreementOf, readLabels } from "./labels";
import type { StoredTrial } from "./store";

const label = (runId: string, mark: LabelRecord["mark"]): [string, LabelRecord] => [
  runId,
  { kind: "awf.case-label/1", runId, case: "a", mark, at: "2026-11-17T00:00:00.000Z" },
];
const trial = (runId: string, extra: object, entries: object[]): StoredTrial =>
  ({
    dir: "",
    record: { runId, case: "a", column: 0, trial: 1, refused: [], ms: 1000, ...extra },
    scores: [{ kind: "awf.case-score/1", at: "2026-11-17T00:00:00.000Z", entries }],
  }) as never;
const passed = { grader: "expect", key: "0".repeat(64), reasons: [], verdict: "passed" };

test("an errored trial is counted once, as not compared, never as a disagreement", () => {
  const labels = new Map([label("r1", "good"), label("r2", "needs-work"), label("r3", "good")]);
  const found = agreementOf(
    [
      trial("r1", { errored: { by: "dataset", phase: "setup", reason: "x" } }, []),
      trial("r2", { errored: { by: "dataset", phase: "setup", reason: "x" } }, []),
      trial("r3", {}, [passed]),
    ],
    labels,
    () => new Set(["expect"]),
  )!;
  expect(found).toMatchObject({
    good: { labeled: 1, agreed: 1 },
    needsWork: { labeled: 0, agreed: 0 },
    notCompared: 2,
    disagreements: [],
  });
});

test("compare sees the numbers of the graders that decide, not an on-demand one's", () => {
  const numbers = (grader: string, recall: number) => ({
    grader,
    key: "0".repeat(64),
    reasons: [],
    verdict: "passed",
    numbers: { recall: { count: recall, of: 10 } },
  });
  const seen = comparedTrial(
    trial("r1", {}, [passed, numbers("match", 4), numbers("spare", 9)]),
    new Set(["expect", "match"]),
  )!;
  expect(seen.numbers).toEqual({ "match.recall": 0.4 });
  expect(seen).toMatchObject({ passed: true, workflowFailed: false, seconds: 1 });
});

test("a /0 label stops the command, named, rather than dropping out of the person's labels", () => {
  const store = mkdtempSync(join(tmpdir(), "awf-lab-labels-"));
  try {
    mkdirSync(join(store, "labels"));
    writeFileSync(
      join(store, "labels", "ds.jsonl"),
      `${JSON.stringify({ kind: "awf.case-label/0", runId: "r", case: "a", mark: "good", at: "2026-11-17T00:00:00.000Z" })}\n`,
    );
    expect(() => readLabels(store, "ds")).toThrow("holds labels of awf.case-label/0");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
