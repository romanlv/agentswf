import { expect, test } from "bun:test";
import type { HarnessAllowance } from "@agentswf/contract/workflow";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import summarize from "./cost";

const claude = (sessionPercent: number): HarnessAllowance => ({
  harness: "claude",
  read: "plan",
  source: "claude /usage",
  windows: [
    { id: "session", label: "session", usedPercent: sessionPercent },
    { id: "week-fable", label: "week (Fable)", usedPercent: 95, models: ["Fable"] },
  ],
});

test("claude writes while its plan has room; a window of other models' doesn't count", async () => {
  const run = await testWorkflow(summarize, null, {
    agents: { writer: answer("adds a --verbose flag") },
    allowance: [claude(40)],
  });
  expect(run.value).toBe("adds a --verbose flag");
  expect(run.agentOf("writer").execution).toMatchObject({ harness: "claude", alias: "claude" });
});

test("a plan past 80%, or one that can't be read, sends the job to a small codex model", async () => {
  for (const allowance of [[claude(85)], []]) {
    const run = await testWorkflow(summarize, null, {
      agents: { writer: answer("adds a --verbose flag") },
      allowance,
    });
    expect(run.agentOf("writer").execution).toEqual({
      harness: "codex",
      model: "gpt-6-luna",
      effort: "low",
      placement: "headless",
    });
  }
});

test("each finished turn is logged with its model and how long it took", async () => {
  const run = await testWorkflow(summarize, null, {
    agents: { writer: answer("adds a --verbose flag") },
  });
  expect(run.logs).toEqual([
    {
      message: "turn",
      fields: { agent: "writer", model: "gpt-6-luna", seconds: expect.any(Number) },
    },
  ]);
});
