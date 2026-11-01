import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import planAndList, { eachRuntime, PLAN, reviewers, unlisted, unmetered } from "./harnesses";

test("each agent runs on the harness, model, effort and placement it was opened with", async () => {
  const run = await testWorkflow(planAndList, null, {
    agents: {
      planner: answer(PLAN, { steps: ["add the flag in src/cli.ts"] }),
      lister: answer("src/cli.ts"),
    },
  });
  expect(run.value).toEqual({ steps: ["add the flag in src/cli.ts"], files: "src/cli.ts" });
  expect(run.agentOf("planner").execution).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "high",
    alias: "claude",
  });
  expect(run.agentOf("lister").execution).toEqual({
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "low",
    placement: "headless",
  });
});

test("a headless claude without metered: true is refused as it opens", async () => {
  const run = await testWorkflow(unmetered, null, { agents: {} });
  expect(() => run.value).toThrow(
    "headless claude is billed per token even on a subscription login; set metered: true to run it",
  );
});

test("an effort the harness doesn't list is refused as the agent opens", async () => {
  const run = await testWorkflow(unlisted, null, { agents: {} });
  expect(() => run.value).toThrow(
    'claude has no effort "ultra"; its levels are low, medium, high, xhigh, max',
  );
});

test("the lead's forks review side by side, and each answers", async () => {
  const run = await testWorkflow(reviewers, null, {
    agents: {
      lead: answer("planned"),
      security: answer("no injection"),
      style: answer("names are fine"),
    },
  });
  expect(run.value).toEqual(["no injection", "names are fine"]);
});

test("each runtime shape resolves to a harness, model, effort and placement", async () => {
  const run = await testWorkflow(eachRuntime, null, { agents: {} });
  expect(run.value).toEqual({
    alias: { harness: "claude", model: "sonnet", alias: "claude" },
    thorough: { harness: "codex", model: "gpt-5.6-sol", effort: "high", alias: "codex" },
    pi: { harness: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", effort: "low" },
    cursor: { harness: "cursor", model: "gpt-5.6-luna-high" },
    quiet: { harness: "codex", model: "gpt-5.6-sol", placement: "headless" },
    meteredClaude: { harness: "claude", model: "sonnet", placement: "headless", metered: true },
  });
});
