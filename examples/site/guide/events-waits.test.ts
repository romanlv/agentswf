import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import flagCleanup, { REMOVED, SMOKE } from "./events-waits";

const shipped = {
  name: "release.shipped" as const,
  data: { version: "2.4.0", flag: "new-billing" },
};
const smoke = answer(SMOKE, { passed: true });
const engineer = [smoke, answer(REMOVED, { commit: "9c1e2aa" })];

test("a quiet first day, then two weeks, then the flag goes: no time passes in the test", async () => {
  const run = await testWorkflow(flagCleanup, {
    id: "2.4.0",
    event: shipped,
    agents: { engineer },
  });
  expect(run.value).toEqual({
    version: "2.4.0",
    ended: "removed new-billing in 9c1e2aa",
  });
  expect(run.timers.map(({ name, state }) => [name, state])).toEqual([
    ["first-day@quiet", "fired"],
    ["hold@sleep", "fired"],
  ]);
});

test("an incident in the first day wins the race, and the flag stays", async () => {
  const run = await testWorkflow(flagCleanup, {
    id: "2.4.0",
    event: shipped,
    agents: { engineer: smoke },
    events: [
      {
        during: "engineer#1",
        name: "incident.opened",
        data: { version: "2.4.0", summary: "invoices doubled" },
      },
    ],
  });
  expect(run.value).toEqual({
    version: "2.4.0",
    ended: "incident: invoices doubled",
  });
  expect(run.turnsOf("engineer")).toHaveLength(1);
  expect(run.timers.find((t) => t.name === "first-day@quiet")?.state).toBe(
    "cancelled",
  );
});

test("between the release and its first day, the run is parked at the race", async () => {
  const run = await testWorkflow(flagCleanup, {
    id: "2.4.0",
    event: shipped,
    agents: { engineer: smoke },
    maxTimers: 0,
  });
  expect(run.parked?.label).toBe("watching 2.4.0");
  expect(run.parked?.until).toBe(
    run.timers.find((t) => t.name === "first-day@quiet")?.due,
  );
});
