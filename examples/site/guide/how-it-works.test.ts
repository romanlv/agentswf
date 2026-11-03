import { expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import checkReadme, { VERDICT } from "./how-it-works";

test("the reviewer's checked answer is the run's result, kept as the review stage", async () => {
  const run = await testWorkflow(checkReadme, {
    agents: { reviewer: answer(VERDICT, { verdict: "approve" }) },
  });
  expect(run.value).toEqual({ verdict: "approve" });
  expect(run.stages.map(({ stage, outcome }) => [stage, outcome])).toEqual([
    ["review", "succeeded"],
  ]);
});

test("a reviewer that never answers is checked in on once, then the run stops with why", async () => {
  const run = await testWorkflow(checkReadme, {
    agents: { reviewer: noAnswer.silent() },
  });
  expect(run.turnsOf("reviewer").map((turn) => turn.nudge)).toEqual([
    false,
    true,
  ]);
  expect(run.ending).toMatchObject({
    kind: "stopped",
    stage: "review",
    reason: expect.stringMatching(/^unanswered:/),
  });
});
