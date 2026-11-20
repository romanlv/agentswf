import { expect, test } from "bun:test";
import { familyOf } from "./families";
import { renderRun } from "./report";

test("a model's family, from its id, with or without a provider's prefix", () => {
  expect(familyOf("claude-haiku-5-5")).toBe("anthropic");
  expect(familyOf("anthropic/claude-sonnet-5-5")).toBe("anthropic");
  expect(familyOf("gpt-6-luna")).toBe("openai");
  expect(familyOf("openai-codex/gpt-5.6-terra")).toBe("openai");
  expect(familyOf("openrouter/google/gemini-3-pro")).toBe("google");
  expect(familyOf("jev")).toBeUndefined();
});

test("the report marks a judge that shares the workflow's family, splits and criteria read, not run", () => {
  const agent = { harness: "claude", model: "claude-haiku-5-5" };
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
        record: { case: "a", column: 0, models: ["claude-sonnet-5-5"], unused: [], kept: [] },
        scores: [
          {
            kind: "awf.case-score/1",
            at: "2026-11-17T00:01:00.000Z",
            entries: [
              {
                grader: "criteria",
                version: "1.0.0",
                key: "0".repeat(64),
                agent,
                verdict: "passed",
                reasons: [],
                parts: [
                  { about: "must: a", verdict: "passed", settled: "majority" },
                  {
                    about: "must: b",
                    verdict: "passed",
                    settled: "agreed",
                    data: { readNotRun: true },
                  },
                ],
              },
            ],
          },
        ],
      } as never,
    ],
    criteria: 2,
  });
  expect(text).toContain("criteria judged 2 · split 2–1 1 · read, not run 1");
  expect(text).toContain(
    "judge: claude/claude-haiku-5-5 ×3, not checked against a person (labeled 0 of 10, needs-work 0 of 3: awf-lab label) · shares the anthropic family with the workflow's claude-sonnet-5-5",
  );
});

test("an alias names its family by the harness that alone runs it", () => {
  expect(familyOf("sonnet", "claude")).toBe("anthropic");
  expect(familyOf("sonnet")).toBeUndefined();
});
