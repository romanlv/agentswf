import { expect, test } from "bun:test";
import type { RunnableWorkflow } from "../workflow-runner";
import { answer, noAnswer } from "./index";
import { runTest } from "./run-test";
import { waiting } from "./script";

const workflow: RunnableWorkflow<null, string> = {
  meta: { name: "waiting-test", description: "waiting test" },
  async run(ctx) {
    const agent = await ctx.agents.open({ key: "worker", runtime: "claude" });
    const first = await agent.run({ prompt: "finish the job" });
    if (first.outcome.kind !== "answered") throw new Error(first.outcome.kind);
    const second = await agent.run({ prompt: "follow up" });
    if (second.outcome.kind !== "answered") throw new Error(second.outcome.kind);
    return `${first.outcome.value}/${second.outcome.value}`;
  },
};
test("scripted waiting is acknowledged through the real control plane and preserves one operation", async () => {
  let calls = 0;
  const run = await runTest(workflow, {
    agents: {
      worker: [answer(() => (++calls < 4 ? waiting("job", 1) : "done")), answer("next")],
    },
  });
  expect(run.value).toBe("done/next");
  expect(run.turnsOf("worker").map((turn) => [turn.n, turn.nudge, turn.outcome])).toEqual([
    [1, false, "waiting"],
    [1, true, "waiting"],
    [1, true, "waiting"],
    [1, true, "answered"],
    [2, false, "answered"],
  ]);
});

test("an async check-in answer is not raced by a tiny real-time response window", async () => {
  const run = await runTest(workflow, {
    agents: {
      worker: [
        answer(async (turn) => {
          if (!turn.nudge) return noAnswer.silent();
          await Bun.sleep(75);
          return "done";
        }),
        answer("next"),
      ],
    },
  });
  expect(run.value).toBe("done/next");
});

for (const runtime of ["codex", "pi", "claude-headless"]) {
  test(`${runtime} scripted placement refuses cooperative waiting`, async () => {
    const unsupported: RunnableWorkflow<null, string> = {
      meta: { name: "unsupported-wait", description: "unsupported wait" },
      async run(ctx) {
        const agent = await ctx.agents.open({
          key: "worker",
          runtime:
            runtime === "claude-headless"
              ? { harness: "claude", model: "test", placement: "headless", metered: true }
              : runtime,
        });
        return (await agent.run({ prompt: "work" })).outcome.kind;
      },
    };
    await expect(
      runTest(unsupported, {
        runtimes: {
          pi: { harness: "pi", model: "test" },
        },
        agents: { worker: answer((turn) => (turn.nudge ? "done" : waiting("job", 1))) },
      }),
    ).rejects.toThrow("waiting rejected");
  });
}
