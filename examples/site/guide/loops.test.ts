import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import fixUntilApproved, { DONE, VERDICT } from "./loops";

const args = { task: "Accept ISO week dates" };
const done = answer(DONE, { summary: "Parses 2026-W05" });
const rejected = (finding: string) => answer(VERDICT, { approved: false, findings: [finding] });
const approved = answer(VERDICT, { approved: true, findings: [] });

describe("the loops page's review loop", () => {
  test("fixes what the reviewer found, in the same sessions, until it approves", async () => {
    const run = await testWorkflow(fixUntilApproved, args, {
      agents: {
        implementer: done,
        reviewer: [rejected("week 53 is refused"), approved],
      },
    });
    expect(run.value).toEqual({ approved: true, rounds: 2 });
    expect(run.turnsOf("implementer").map((turn) => turn.prompt)).toEqual([
      "Implement this task: Accept ISO week dates",
      "Fix what the reviewer found:\n- week 53 is refused",
    ]);
    expect(run.turnsOf("reviewer")[1]!.prompt).toContain("Check each one");
  });

  test("stops at the bound and returns what is still open", async () => {
    const run = await testWorkflow(fixUntilApproved, args, {
      agents: { implementer: done, reviewer: rejected("still no week 53") },
    });
    expect(run.value).toEqual({ approved: false, rounds: 4, open: ["still no week 53"] });
    expect(run.turnsOf("implementer")).toHaveLength(4);
    expect(run.turnsOf("reviewer")).toHaveLength(4);
  });

  test("a failed implementer is replaced once, and the new one gets the open findings", async () => {
    const run = await testWorkflow(fixUntilApproved, args, {
      agents: {
        implementer: [done, reply.failed("harness crashed")],
        "implementer#2": done,
        reviewer: [rejected("week 53 is refused"), approved],
      },
    });
    expect(run.value).toEqual({ approved: true, rounds: 2 });
    const handover = run.turnsOf("implementer#2")[0]!.prompt;
    expect(handover).toContain("Another agent was working on this task");
    expect(handover).toContain("- week 53 is refused");
  });

  test("a second failure stops the run with its reason", async () => {
    const run = await testWorkflow(fixUntilApproved, args, {
      agents: {
        implementer: reply.timedOut("no progress"),
        "implementer#2": reply.failed("harness crashed"),
        reviewer: approved,
      },
    });
    expect(run.stopped?.reason).toBe("implementer failed: harness crashed");
    expect(run.turnsOf("reviewer")).toHaveLength(0);
  });

  test("a missing login stops at once, with no replacement", async () => {
    const run = await testWorkflow(fixUntilApproved, args, {
      agents: { implementer: reply.needsLogin(), reviewer: approved },
    });
    expect(run.stopped?.reason).toContain("login");
    expect(run.agents.map((agent) => agent.key)).not.toContain("implementer#2");
  });

  test("a reviewer that never answers stops the run", async () => {
    const run = await testWorkflow(fixUntilApproved, args, {
      agents: { implementer: done, reviewer: reply.silent() },
    });
    expect(run.stopped?.reason).toStartWith("reviewer unanswered:");
    expect(run.turnsOf("reviewer").map((turn) => turn.nudge)).toEqual([false, true]);
  });
});
