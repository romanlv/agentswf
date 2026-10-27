import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import mrReview, { type Finding, Pass } from "./mr-review";

// Declared in the sketch, as the ledger and GitLab are: the loop's own repository gives them a body.
declare function changes(mr: { iid: number; head: string; authorized: boolean }): {
  iid: number;
  head: string;
  authorized: boolean;
  threads: { id: string; resolved: boolean }[];
};
declare function pass(given: Partial<Pass>): Pass;
declare function found(given: Partial<Finding>): Finding;
declare const REVIEWS: string;

test.todo("a push during a review is reviewed next, and nothing is posted at the old head", async () => {
  const run = await testWorkflow(mrReview, {
    id: "2084",
    event: { name: "mr.changes", data: changes({ iid: 2084, head: "aaa", authorized: true }) },
    agents: { reviewer: answer(Pass, pass({ findings: [found({ verdict: "open" })] })) },
    events: [
      {
        during: "reviewer#1",
        name: "mr.changes",
        data: changes({ iid: 2084, head: "bbb", authorized: true }),
      },
    ],
    files: { [REVIEWS]: {} },
  });
  expect(run.turnsOf("reviewer")[1]?.prompt).toContain("aaa..bbb");
  expect(run.stages.map((s) => s.stage)).not.toContain("post-f1@aaa");
});

async function refused(): Promise<void> {
  // @ts-expect-error An iid is a number.
  await testWorkflow(mrReview, {
    id: "2084",
    event: { name: "mr.closed", data: { iid: "2084", merged: true } },
  });
}
void refused;
