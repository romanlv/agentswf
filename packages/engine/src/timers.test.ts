import { expect, test } from "bun:test";
import { defineWorkflow } from "@agentswf/contract/workflow";
import { caseRun, startCase } from "./testing";
import { answer, testWorkflow } from "./workflow-testing";

const DAY = 86_400_000;

/** Story 037's case 1: a reminder every two days, an approval, or an expiry at fourteen. */
const approval = caseRun(async (workflow) => {
  const approvals = await workflow.participants.connect({ key: "approvals", to: "code" });
  const approver = await workflow.agents.open({ key: "approver", runtime: "claude" });
  const expiry = workflow.timer("doc-expires", "14d");
  const started = workflow.now().getTime();
  for (let round = 1; ; round++) {
    const next = await workflow.race(
      `approval-${round}`,
      { reply: approvals, remind: "2d", expiry },
      { label: "awaiting approval" },
    );
    const day = Math.round((workflow.now().getTime() - started) / DAY);
    if (next.expiry) return { ended: "expired", day, round };
    if (next.reply?.text === "approved") return { ended: "approved", day, round };
    if (next.remind) await approver.run({ prompt: `Reminder ${round}: the doc awaits approval.` });
  }
});

test("a two-day reminder and a fourteen-day expiry run in no time on the test's clock", async () => {
  const started = Date.now();
  const run = await testWorkflow(approval, {
    ...startCase,
    agents: { approver: answer("noted") },
  });
  expect(run.value).toEqual({ ended: "expired", day: 14, round: 7 });
  expect(run.turnsOf("approver")).toHaveLength(6);
  expect(run.timers.filter((t) => t.state === "fired").map((t) => t.name)).toEqual([
    "doc-expires",
    ...[1, 2, 3, 4, 5, 6].map((round) => `approval-${round}@remind`),
  ]);
  // The seventh round's reminder lost to the expiry, and the race cancelled it.
  expect(run.timers.find((t) => t.name === "approval-7@remind")?.state).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("an approval after two reminders ends the wait at its round", async () => {
  const run = await testWorkflow(approval, {
    ...startCase,
    agents: { approver: answer("noted") },
    events: [
      {
        during: "approver#2",
        name: "participant:reply",
        from: "approvals",
        data: { text: "approved" },
      },
    ],
  });
  expect(run.value).toEqual({ ended: "approved", day: 4, round: 3 });
  expect(run.timers.find((t) => t.name === "doc-expires")?.state).toBe("pending");
});

test("a loop of timers that nothing answers parks after maxTimers, and the test says so", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      for (let round = 1; ; round++) await workflow.sleep(`nudge-${round}`, "1h");
    }),
    { ...startCase, maxTimers: 5 },
  );
  expect(run.parked).toBeDefined();
  expect(() => run.value).toThrow("after 5 timers fired (maxTimers)");
  expect(run.timers.filter((t) => t.state === "fired")).toHaveLength(5);
});

test("workflow.now() and the events a test sends follow the test's clock", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const before = workflow.now().getTime();
      await workflow.sleep("follow-up", "14d");
      const [started] = await workflow.receive();
      return {
        days: Math.round((workflow.now().getTime() - before) / DAY),
        event: started?.name ?? null,
      };
    }),
    startCase,
  );
  expect(run.value).toEqual({ days: 14, event: "dd.changes" });
});

const followUp = defineWorkflow({
  meta: { name: "follow-up", description: "Releases, waits fourteen days, and checks." },
  async run(workflow) {
    await workflow.stage("release", async () => undefined);
    const released = workflow.now().getTime();
    await workflow.sleep("follow-up", "14d");
    await workflow.stage("check", async () => undefined);
    return Math.round((workflow.now().getTime() - released) / DAY);
  },
});

test("a workflow without events sleeps: on the test's clock in no time, or parks at maxTimers 0", async () => {
  expect((await testWorkflow(followUp, null)).value).toBe(14);
  const parked = await testWorkflow(followUp, null, { maxTimers: 0 });
  expect(parked.parked?.until).toBeDefined();
  expect(parked.stages.map((record) => record.stage)).toEqual(["release"]);
});
