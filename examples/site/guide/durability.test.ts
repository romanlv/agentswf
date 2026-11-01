import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import fixIssue, { BUILT, PLAN, VERDICT } from "./durability";

const args = { issue: "#212: dates before 1970 parse as null" };
const plan = { branch: "fix/212", steps: ["accept negative epochs"] };
const built = { commit: "4be1c07" };

test("a rejected review stops the attempt in review, after plan and implement are recorded", async () => {
  const run = await testWorkflow(fixIssue, args, {
    agents: {
      coder: [answer(PLAN, plan), answer(BUILT, built)],
      reviewer: answer(VERDICT, { approved: false, findings: ["no test for 1969-12-31"] }),
    },
  });
  expect(run.stopped).toMatchObject({ stage: "review", reason: "no test for 1969-12-31" });
  expect(run.stages.map(({ stage, outcome }) => [stage, outcome])).toEqual([
    ["plan", "succeeded"],
    ["implement", "succeeded"],
    ["review", "stopped"],
  ]);
});

// #region continue
test("a continue reuses plan and implement, and only the review runs again", async () => {
  const run = await testWorkflow(fixIssue, args, {
    recorded: { plan, implement: built }, // what attempt 1 recorded
    agents: { reviewer: answer(VERDICT, { approved: true, findings: [] }) },
  });
  expect(run.value).toEqual({ approved: true, findings: [] });
  expect(run.turnsOf("coder")).toEqual([]); // reused stages ask no agent anything
  expect(run.turnsOf("reviewer")[0]!.prompt).toContain("4be1c07 on fix/212");
});
// #endregion continue
