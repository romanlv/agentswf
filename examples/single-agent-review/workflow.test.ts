import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import review, { FINDINGS_SCHEMA } from "./workflow";

const prepare = (...argv: string[]) => review.prepare({ argv, cwd: "/work" });
const finding = {
  file: "src/a.ts",
  line: 3,
  severity: "must-fix",
  claim: "The retry charges the card twice.",
  evidence: "charge() runs before the idempotency key is stored",
} as const;

describe("single-agent-review", () => {
  test("reads its arguments: a range, the request, a pinned public skill, a runtime", () => {
    expect(prepare()).toMatchObject({ range: "origin/main...HEAD" });
    expect(prepare()).not.toHaveProperty("skill");
    expect(
      prepare(
        "--range",
        "abc...HEAD",
        "--request",
        "request.md",
        "--skill",
        "owner/repo/code-review@v1.2",
        "--runtime",
        "codex/gpt-6-luna",
      ),
    ).toEqual({
      range: "abc...HEAD",
      request: "/work/request.md",
      skill: { repo: "owner/repo", skill: "code-review", ref: "v1.2" },
      runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
    });
    expect(prepare("--runtime", "claude/sonnet").runtime).toMatchObject({ metered: true });
    expect(() => prepare("--skill", "code-review")).toThrow("--skill is owner/repo/skill@ref");
    expect(() => prepare("--skill", "owner/repo/code-review")).toThrow("pinned to a ref");
    expect(() => prepare("--lenses", "a")).toThrow("unknown flag --lenses");
    expect(() => prepare("--range", "a", "--range", "b")).toThrow("--range is given twice");
  });

  test("one agent, no skill but the one named, one turn; its findings are the result", async () => {
    const run = await testWorkflow(review, prepare(), {
      agents: { reviewer: answer(FINDINGS_SCHEMA, { findings: [finding] }) },
    });
    expect(run.value).toEqual({ range: "origin/main...HEAD", skill: null, findings: [finding] });
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0]!.prompt).toContain("git diff origin/main...HEAD");
    expect(run.turns[0]!.prompt).not.toContain("title and description are in");
    // No skill named is none at all, not the operator's.
    expect(run.agentOf("reviewer").skills).toEqual([]);
    expect(review.present!(run.value)).toBe(
      "must-fix src/a.ts:3 — The retry charges the card twice.",
    );
  });

  test("the runtime named is the one the reviewer runs on", async () => {
    const run = await testWorkflow(review, prepare("--runtime", "codex/gpt-6-luna"), {
      agents: { reviewer: answer(FINDINGS_SCHEMA, { findings: [] }) },
    });
    expect(run.agentOf("reviewer").execution).toMatchObject({
      harness: "codex",
      model: "gpt-6-luna",
      placement: "headless",
    });
  });

  test("the request is named in the prompt when given", async () => {
    const run = await testWorkflow(review, prepare("--request", "pr.md"), {
      agents: { reviewer: answer(FINDINGS_SCHEMA, { findings: [] }) },
    });
    expect(run.turns[0]!.prompt).toContain("title and description are in /work/pr.md");
    expect(review.present!(run.value)).toBe("no findings");
  });

  test("a review that never comes fails the run with why", async () => {
    const run = await testWorkflow(review, prepare(), {
      agents: { reviewer: reply.blocked("waiting on a permission prompt") },
    });
    expect(() => run.value).toThrow("no review: blocked: waiting on a permission prompt");
  });
});
