import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import stalePr from "./timers";

const opened = { name: "pr.opened" as const, data: { pr: 42 } };
const reviewed = answer("reviewed");

test("three quiet days after opening, it asks after the pull request", async () => {
  const run = await testWorkflow(stalePr, {
    id: "42",
    event: opened,
    agents: { reviewer: [reviewed, reviewed] },
  });
  expect(run.value).toEqual({ pr: 42, ended: "stale" });
  expect(run.timers.map(({ name, state }) => [name, state])).toEqual([
    ["stale-0", "fired"],
  ]);
});

test("a push cancels the timer and starts a new one under the next name", async () => {
  const run = await testWorkflow(stalePr, {
    id: "42",
    event: opened,
    agents: { reviewer: [reviewed, reviewed, reviewed] },
    events: [
      {
        during: "reviewer#1",
        name: "pr.pushed",
        data: { pr: 42, head: "9c1e2aa" },
      },
    ],
  });
  expect(run.value).toEqual({ pr: 42, ended: "stale" });
  expect(run.turnsOf("reviewer")[1]?.prompt).toContain("9c1e2aa");
  expect(run.timers.map(({ name, state }) => [name, state])).toEqual([
    ["stale-0", "cancelled"],
    ["stale-1", "fired"],
  ]);
});

test("a closed pull request ends the run before the timer", async () => {
  const run = await testWorkflow(stalePr, {
    id: "42",
    event: opened,
    agents: { reviewer: reviewed },
    events: [{ during: "reviewer#1", name: "pr.closed", data: { pr: 42 } }],
  });
  expect(run.value).toEqual({ pr: 42, ended: "closed" });
});

test("between pushes, the run parks until the timer is due", async () => {
  const run = await testWorkflow(stalePr, {
    id: "42",
    event: opened,
    agents: { reviewer: reviewed },
    maxTimers: 0,
  });
  expect(run.parked?.label).toBe("#42: waiting for a push, round 1");
  expect(run.parked?.until).toBe(
    run.timers.find((t) => t.name === "stale-0")?.due,
  );
});
