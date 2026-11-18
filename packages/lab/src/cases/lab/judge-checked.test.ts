import { expect, test } from "bun:test";
import type { LabelRecord } from "../format/records";
import { judgeLabeled } from "./labels";
import { renderRun } from "./report";
import type { StoredTrial } from "./store";

const agent = { harness: "claude", model: "claude-haiku-5-5" };
const entry = (extra: object) => ({
  grader: "criteria",
  key: "0".repeat(64),
  reasons: [],
  ...extra,
});

function judgeLine(labeled?: { labeled: number; needsWork: number }): string {
  const { text } = renderRun({
    run: {
      kind: "awf.case-run/1",
      id: "20261117-000000-abcd",
      dataset: "ds",
      folders: [{ path: "/p", branch: "main", commit: null, dirty: false, env: "0".repeat(64) }],
      columns: [{ folder: 0, params: {} }],
      asked: [{ case: "a", trials: 1 }],
      started: "2026-11-17T00:00:00.000Z",
      finished: "2026-11-17T00:01:00.000Z",
    },
    rows: [],
    trials: [
      {
        record: { case: "a", column: 0, models: ["gpt-6-luna"], unused: [], kept: [] },
        scores: [
          {
            kind: "awf.case-score/1",
            at: "2026-11-17T00:01:00.000Z",
            entries: [entry({ version: "1.0.0", agent, verdict: "passed", parts: [] })],
          },
        ],
      } as never,
    ],
    criteria: 1,
    ...(labeled ? { judgeLabeled: labeled } : {}),
  });
  return text.split("\n").find((l) => l.startsWith("judge:"))!;
}

test("the judge is checked at 10 labeled trials it graded, 3 of them needs-work", () => {
  expect(judgeLine()).toContain("not checked against a person (labeled 0 of 10, needs-work 0 of 3");
  expect(judgeLine({ labeled: 12, needsWork: 2 })).toContain("not checked against a person");
  expect(judgeLine({ labeled: 10, needsWork: 3 })).toBe("judge: claude/claude-haiku-5-5 ×3");
});

test("only labeled trials the current judge graded count, each workflow run once", () => {
  const trial = (runId: string, extra: object): StoredTrial =>
    ({
      dir: "",
      record: { runId, case: "a" },
      scores: [
        { kind: "awf.case-score/1", at: "2026-11-17T00:00:00.000Z", entries: [entry(extra)] },
      ],
    }) as never;
  const label = (runId: string, mark: LabelRecord["mark"]): [string, LabelRecord] => [
    runId,
    { kind: "awf.case-label/1", runId, case: "a", mark, at: "2026-11-17T00:00:00.000Z" },
  ];
  const labels = new Map([label("r1", "good"), label("r2", "needs-work"), label("r3", "good")]);
  const graded = { version: "1.0.2", agent, verdict: "passed" };
  const runs = [
    [trial("r1", graded), trial("r2", graded)],
    // A reused copy of r1 counts once; r3 was judged by another model, r4 has no label.
    [trial("r1", graded), trial("r3", { ...graded, agent: { ...agent, model: "other" } })],
    [trial("r4", graded), trial("r2", { ...graded, version: "1.1.0" })],
  ];
  expect(judgeLabeled(runs, labels, { ...agent, minor: "1.0" })).toEqual({
    labeled: 2,
    needsWork: 1,
  });
});
