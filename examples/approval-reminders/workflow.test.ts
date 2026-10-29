import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import approval, { Reminder } from "./workflow";

const submitted = {
  name: "doc.submitted" as const,
  data: { doc: "rfc-12", remindEvery: "2d", expiresIn: "14d" },
};
const writer = answer(Reminder, { text: "rfc-12 still awaits your approval." });

describe("approval", () => {
  test("reminds every two days and expires at fourteen, on the test's clock", async () => {
    const run = await testWorkflow(approval, {
      id: "rfc-12",
      event: submitted,
      agents: { writer },
    });
    expect(run.value).toEqual({ doc: "rfc-12", ended: "expired", round: 7, by: null });
    expect(run.turnsOf("writer")).toHaveLength(6);
    expect(run.timers.find((t) => t.name === "approval-7@remind")?.state).toBe("cancelled");
  });

  test("an approval during the second reminder ends it at round 3", async () => {
    const run = await testWorkflow(approval, {
      id: "rfc-12",
      event: submitted,
      agents: { writer },
      events: [
        {
          during: "writer#2",
          name: "participant:reply",
          from: "approvals",
          data: { text: "Approved, thanks." },
        },
      ],
    });
    expect(run.value).toEqual({ doc: "rfc-12", ended: "approved", round: 3, by: "engineer" });
  });

  test("it parks at its first race, waiting for the reply or the reminder", async () => {
    const run = await testWorkflow(approval, {
      id: "rfc-12",
      event: submitted,
      agents: { writer },
      maxTimers: 0,
    });
    expect(run.parked?.label).toBe("awaiting approval of rfc-12, round 1");
    expect(run.parked?.until).toBe(run.timers.find((t) => t.name === "approval-1@remind")?.due);
  });
});
