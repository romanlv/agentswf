import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import ciFix, { ciFixByRace, ciFixBySelect, FIX } from "./events";

const failed = (job: string) => ({
  name: "ci.failed" as const,
  data: { pr: 212, job, url: `https://ci.example.com/212/${job}` },
});
const fixer = answer(FIX, { commit: "4be1c07" });

test("a failure starts the run, the fixer pushes a fix, and the run parks", async () => {
  const run = await testWorkflow(ciFix, {
    id: "212",
    event: failed("unit"),
    agents: { fixer },
  });
  expect(run.turnsOf("fixer")).toHaveLength(1);
  expect(run.turnsOf("fixer")[0]!.prompt).toContain("CI job unit failed");
  expect(run.parked?.label).toBe("waiting on CI for #212");
});

test("failures that arrive during a fix are one batch: the latest gets the next fix", async () => {
  const run = await testWorkflow(ciFix, {
    id: "212",
    event: failed("unit"),
    agents: { fixer },
    events: [
      { during: "fixer#1", ...failed("lint") },
      { during: "fixer#1", ...failed("e2e") },
    ],
  });
  expect(
    run.turnsOf("fixer").map((t) => t.prompt.match(/job (\w+)/)?.[1]),
  ).toEqual(["unit", "e2e"]);
  expect(run.parked).toBeDefined();
});

test("the pull request closing ends the run for good", async () => {
  const run = await testWorkflow(ciFix, {
    id: "212",
    event: failed("unit"),
    agents: { fixer },
    events: [
      { during: "fixer#1", name: "pr.closed", data: { pr: 212, merged: true } },
    ],
  });
  expect(run.value).toEqual({ pr: 212, merged: true });
});

test("as a select, each failure is fixed in turn", async () => {
  const run = await testWorkflow(ciFixBySelect, {
    id: "212",
    event: failed("unit"),
    agents: { fixer: answer("pushed") },
    events: [
      { during: "fixer#1", ...failed("lint") },
      { during: "fixer#2", name: "pr.closed", data: { pr: 212, merged: true } },
    ],
  });
  expect(run.turnsOf("fixer")).toHaveLength(2);
  expect(run.value).toEqual({ pr: 212, merged: true });
});

test("as a race, the fix ends the run when it finishes first", async () => {
  const run = await testWorkflow(ciFixByRace, {
    id: "212",
    event: failed("unit"),
    agents: { fixer: answer("pushed") },
  });
  expect(run.value).toEqual({ pr: 212, fix: "answered" });
});

test("as a race, the pull request closing mid-fix wins, and the fix is cancelled", async () => {
  const run = await testWorkflow(ciFixByRace, {
    id: "212",
    event: failed("unit"),
    agents: { fixer: answer("pushed") },
    events: [
      { during: "fixer#1", name: "pr.closed", data: { pr: 212, merged: true } },
    ],
  });
  expect(run.value).toEqual({ pr: 212, fix: "cancelled" });
});
