import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import postDeploy, { CHECK } from "./hosting-events";

const deployed = {
  name: "deploy.done" as const,
  data: { service: "api", version: "v42" },
};
const checker = answer(CHECK, { healthy: true, notes: "error rate flat" });

const parked = () =>
  testWorkflow(postDeploy, {
    id: "api-v42",
    event: deployed,
    agents: { checker },
    maxTimers: 0,
  });

test("it parks at the race, due an hour after the deploy", async () => {
  const run = await parked();
  const settled = run.timers.find((t) => t.name === "settle@settled");
  expect(run.ending).toMatchObject({
    kind: "parked",
    label: "api v42 settling",
    until: settled?.due,
  });
  expect(run.turnsOf("checker")).toHaveLength(0);
});

test("once the hour is due, the checker runs and the run returns", async () => {
  const run = await testWorkflow(postDeploy, {
    id: "api-v42",
    event: deployed,
    agents: { checker },
  });
  expect(run.value).toEqual({
    service: "api",
    version: "v42",
    checked: true,
    healthy: true,
    notes: "error rate flat",
  });
  expect(run.timers.map(({ name, state }) => [name, state])).toEqual([
    ["settle@settled", "fired"],
  ]);
});

test("a rollback while it is parked continues it, and nothing is checked", async () => {
  const first = await parked();
  const run = await testWorkflow(postDeploy, {
    id: "api-v42",
    // What `awf emit … deploy.rolled-back` appends while the run is parked.
    mailbox: [
      ...first.mailbox,
      {
        version: 1,
        at: new Date().toISOString(),
        kind: "event",
        id: "rollback-v42",
        name: "deploy.rolled-back",
        data: { version: "v42" },
        from: "operator",
      },
    ],
    agents: { checker },
  });
  expect(run.value).toEqual({ service: "api", version: "v42", checked: false });
  expect(run.turnsOf("checker")).toHaveLength(0);
  expect(run.timers.map(({ name, state }) => [name, state])).toEqual([
    ["settle@settled", "cancelled"],
  ]);
});
