import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import route, { ROUTE } from "./decisions";

const ticket = "Checkout charges the card twice after a timeout.";

test("a sure decision is taken, its urgency read from the expected level, and no agent opens", async () => {
  // #region script
  const run = await testWorkflow(
    route,
    { ticket },
    {
      decisions: {
        route: {
          team: { payments: 0.97, accounts: 0.02, frontend: 0.01 },
          bug: 0.95,
          urgency: [0.1, 0.3, 0.6],
        },
      },
    },
  );
  // #endregion script
  expect(run.value).toEqual({
    team: "payments",
    bug: true,
    urgency: "now",
    by: "decision",
  });
  expect(run.agents).toEqual([]);
  expect(run.decisions[0]?.state).toEqual({ ticket });
});

test("a split urgency lands on the middle level, though `level` alone would say now", async () => {
  const run = await testWorkflow(
    route,
    { ticket },
    {
      decisions: {
        route: { team: "payments", bug: 0.95, urgency: [0.45, 0.1, 0.45] },
      },
    },
  );
  expect(run.value.urgency).toBe("this week");
});

test("an unsure team goes to an agent", async () => {
  const run = await testWorkflow(
    route,
    { ticket },
    {
      decisions: {
        route: {
          team: { payments: 0.55, accounts: 0.4, frontend: 0.05 },
          bug: 0.95,
          urgency: 2,
        },
      },
      agents: {
        router: answer(ROUTE, { team: "accounts", bug: true, urgency: "now" }),
      },
    },
  );
  expect(run.value).toEqual({
    team: "accounts",
    bug: true,
    urgency: "now",
    by: "agent",
  });
});

test("an unsure yes/no goes to an agent; a sure no is as good as a sure yes", async () => {
  const unsure = await testWorkflow(
    route,
    { ticket },
    {
      decisions: { route: { team: "payments", bug: 0.6, urgency: 0 } },
      agents: {
        router: answer(ROUTE, {
          team: "payments",
          bug: false,
          urgency: "later",
        }),
      },
    },
  );
  expect(unsure.value.by).toBe("agent");
  const no = await testWorkflow(
    route,
    { ticket },
    { decisions: { route: { team: "payments", bug: 0.05, urgency: 0 } } },
  );
  expect(no.value).toEqual({
    team: "payments",
    bug: false,
    urgency: "later",
    by: "decision",
  });
});

test("a failed decision goes to the agent", async () => {
  const run = await testWorkflow(
    route,
    { ticket },
    {
      decisions: { route: new Error("openrouter 503: unavailable") },
      agents: {
        router: answer(ROUTE, { team: "payments", bug: true, urgency: "now" }),
      },
    },
  );
  expect(run.value).toEqual({
    team: "payments",
    bug: true,
    urgency: "now",
    by: "agent",
  });
});
