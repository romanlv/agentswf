import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import review, { REVIEW } from "./pr-review";

test("a push starts the run, the reviewer reviews it, and it parks for the next", async () => {
  const run = await testWorkflow(review, {
    id: "pr-7",
    event: { name: "pr.pushed", data: { sha: "abc123", branch: "fix-login" } },
    agents: {
      reviewer: answer(REVIEW, { summary: "Looks right; add a test." }),
    },
  });
  expect(run.turnsOf("reviewer")).toHaveLength(1);
  expect(run.ending).toMatchObject({
    kind: "parked",
    label: "reviewing fix-login",
  });
});
