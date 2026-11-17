import { expect, test } from "bun:test";
import { renderRun } from "./report";

// The judge as a person checked it: until task 1 records one, the lab ships none.
const CHECKED = { version: "1.0.0", harness: "claude", model: "claude-haiku-5-5" };

const entry = (extra: object) => ({
  grader: "criteria",
  key: "0".repeat(64),
  reasons: [],
  ...extra,
});

function judgeLine(entries: object[]): string {
  const { text } = renderRun({
    run: {
      kind: "awf.case-run/0",
      number: 1,
      dataset: "ds",
      folders: [{ path: "/p", branch: "main", commit: null, dirty: false, env: "0".repeat(64) }],
      asked: [{ case: "a", trials: entries.length }],
      started: "2026-11-17T00:00:00.000Z",
      finished: "2026-11-17T00:01:00.000Z",
    },
    rows: [],
    trials: entries.map(
      (e) =>
        ({
          record: { case: "a", column: 0, models: ["gpt-6-luna"], unused: [], kept: [] },
          scores: [{ kind: "awf.case-score/0", at: "2026-11-17T00:01:00.000Z", entries: [e] }],
        }) as never,
    ),
    criteria: 1,
    judgeChecked: CHECKED,
  });
  return text.split("\n").find((l) => l.startsWith("judge:"))!;
}

const agent = { harness: "claude", model: "claude-haiku-5-5" };
const judged = entry({ version: "1.0.1", agent, verdict: "passed", parts: [] });

test("a judge on the checked agent and minor is not marked, a skipped or errored trial aside", () => {
  expect(judgeLine([judged, entry({ skipped: true }), entry({ errored: { reason: "x" } })])).toBe(
    "judge: claude/claude-haiku-5-5",
  );
});

test("another model or minor marks the judge not checked against a person", () => {
  expect(
    judgeLine([
      entry({ version: "1.0.1", agent: { ...agent, model: "claude-sonnet-5-5" }, parts: [] }),
    ]),
  ).toContain("not checked against a person");
  expect(judgeLine([entry({ version: "1.1.0", agent, parts: [] })])).toContain(
    "not checked against a person",
  );
});
