import { describe, expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";
import scopeIssue, { changelog, PLAN, planAndReview, SCOPE } from "./agents";

describe("scope-issue", () => {
  test("the checked answer is the result; the instructions go with the agent", async () => {
    const run = await testWorkflow(scopeIssue, null, {
      agents: {
        scoper: answer(SCOPE, { files: ["src/cache.ts"], risk: "low" }),
      },
    });
    expect(run.value).toEqual({ files: ["src/cache.ts"], risk: "low" });
    expect(run.agentOf("scoper").instructions).toContain(
      "You never change it.",
    );
    expect(run.turnsOf("scoper")[0]!.prompt).toStartWith("Read ISSUE.md.");
  });

  test("any other ending stops the run with its kind and reason", async () => {
    const run = await testWorkflow(scopeIssue, null, {
      agents: { scoper: noAnswer.blocked("a permission prompt is showing") },
    });
    expect(run.ending).toMatchObject({
      kind: "stopped",
      reason: "blocked: a permission prompt is showing",
    });
  });
});

const TWO_TURNS = defineWorkflow({
  meta: {
    name: "two-turns",
    description: "Two turns on one agent, whatever the first's ending.",
  },
  async run(wf) {
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
    const first = await agent.run({ prompt: "one" });
    try {
      const second = await agent.run({ prompt: "two" });
      return [first.outcome.kind, second.outcome.kind];
    } catch (error) {
      return [first.outcome.kind, `rejected: ${(error as Error).message}`];
    }
  },
});

describe("endings", () => {
  test("unanswered and blocked leave the agent open for another turn", async () => {
    for (const ending of [noAnswer.silent(), noAnswer.blocked()]) {
      const run = await testWorkflow(TWO_TURNS, null, {
        agents: { a: [ending, answer("ok")] },
      });
      expect(run.value[1]).toBe("answered");
    }
  });

  test("failed and timed-out close the agent: its next turn rejects", async () => {
    for (const ending of [noAnswer.failed(), noAnswer.timedOut()]) {
      const run = await testWorkflow(TWO_TURNS, null, {
        agents: { a: [ending] },
      });
      expect(run.value[1]).toBe("rejected: logical agent is closed");
    }
  });

  test("a missing login fails the turn with what the operator runs", async () => {
    const LOGIN = defineWorkflow({
      meta: { name: "login", description: "One turn, its failure's login." },
      async run(wf) {
        const agent = await wf.agents.open({ key: "a", runtime: "claude" });
        const { outcome } = await agent.run({ prompt: "one" });
        return outcome.kind === "failed" && outcome.login
          ? outcome.login
          : null;
      },
    });
    const run = await testWorkflow(LOGIN, null, {
      agents: { a: noAnswer.needsLogin() },
    });
    expect(run.value).toMatchObject({
      harness: "claude",
      run: expect.stringContaining("/login"),
    });
  });

  test("a schema keyword outside the supported set rejects the turn", async () => {
    const PATTERNED = defineWorkflow({
      meta: { name: "patterned", description: "A schema with a pattern." },
      async run(wf) {
        const agent = await wf.agents.open({ key: "a", runtime: "claude" });
        const { outcome } = await agent.run({
          prompt: "Name a branch.",
          schema: Type.Object({ branch: Type.String({ pattern: "^feat/" }) }),
        });
        return outcome.answered ? outcome.value : null;
      },
    });
    const run = await testWorkflow(PATTERNED, null, {
      agents: { a: answer("unused") },
    });
    expect(() => run.value).toThrow(
      'output schema keyword "pattern" is unsupported',
    );
  });
});

describe("plan-and-review", () => {
  const plan = {
    steps: ["Expire the cache on write"],
    files: ["src/cache.ts"],
  };

  test("turns, a compaction, forks from the plan, then a cheaper last turn", async () => {
    const run = await testWorkflow(planAndReview, null, {
      agents: {
        planner: [
          answer(PLAN, plan),
          answer(PLAN, plan),
          answer("Expire the cache on write"),
        ],
        security: answer("No problems."),
        tests: noAnswer.failed("codex exited"),
      },
      compactions: { planner: answer("The plan: expire the cache on write.") },
    });
    expect(run.value).toEqual({
      plan,
      reviews: ["No problems.", "tests: failed"],
      title: "Expire the cache on write",
    });
    expect(run.compactionsOf("planner")[0]!.focus).toStartWith(
      "Keep the final plan",
    );
    expect(run.agentOf("security")).toMatchObject({
      forkedFrom: { key: "planner", turns: 2 },
      instructions: "You look for security problems.",
      execution: { harness: "codex", effort: "high" },
    });
    expect(run.setsOf("planner")).toMatchObject([{ effort: "low" }]);
    expect(run.turnsOf("planner").map((turn) => turn.effort)).toEqual([
      "high",
      "high",
      "low",
    ]);
  });
});

describe("changelog", () => {
  test("the writer has exactly the skill it was given", async () => {
    const run = await testWorkflow(changelog, null, {
      agents: { writer: answer("Fixed: …") },
    });
    expect(run.value).toBe("Fixed: …");
    expect(run.agentOf("writer").skills).toEqual(["changelog"]);
  });
});
