import { expect, test } from "bun:test";
import type { WorkflowDefinition } from "@agentswf/contract/workflow";
import { answer, reply, testWorkflow } from "./index";

const workflow: WorkflowDefinition<null, string> = {
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
  const run = await testWorkflow(workflow, null, {
    agents: {
      worker: [answer(() => (++calls < 4 ? reply.waiting("job", 1) : "done")), answer("next")],
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
