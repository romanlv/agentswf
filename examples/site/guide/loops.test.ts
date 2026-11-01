import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import reviewLoop, { DONE, VERDICT } from "./loops";

const args = { task: "Accept ISO week dates" };
const done = answer(DONE, { summary: "Parses 2026-W05" });
const rejected = (change: string) => answer(VERDICT, { approved: false, changes: [change] });
const approved = answer(VERDICT, { approved: true, changes: [] });

describe("the loops page's review loop", () => {
  test("makes the reviewer's changes, in the same sessions, until it approves", async () => {
    const run = await testWorkflow(reviewLoop, args, {
      agents: { implementer: done, reviewer: [rejected("Accept week 53"), approved] },
    });
    expect(run.value).toEqual({ approved: true, rounds: 2 });
    expect(run.turnsOf("implementer").map((turn) => turn.prompt)).toEqual([
      "Implement this task: Accept ISO week dates",
      "Make these changes:\nAccept week 53",
    ]);
    expect(run.turnsOf("reviewer")[1]!.prompt).toContain("Check each one");
  });

  test("stops at the bound and returns what is still open", async () => {
    const run = await testWorkflow(reviewLoop, args, {
      agents: { implementer: done, reviewer: rejected("Still no week 53") },
    });
    expect(run.value).toEqual({ approved: false, rounds: 3, open: ["Still no week 53"] });
    expect(run.turnsOf("implementer")).toHaveLength(3);
  });

  test("a failed implementer is replaced once, and the new one gets the open changes", async () => {
    const run = await testWorkflow(reviewLoop, args, {
      agents: {
        implementer: [done, reply.failed("harness crashed")],
        "implementer#2": done,
        reviewer: [rejected("Accept week 53"), approved],
      },
    });
    expect(run.value).toEqual({ approved: true, rounds: 2 });
    const handover = run.turnsOf("implementer#2")[0]!.prompt;
    expect(handover).toContain("Take over from an agent that stopped");
    expect(handover).toContain("Make these changes:\nAccept week 53");
  });

  test("a second failure stops the run with its reason", async () => {
    const run = await testWorkflow(reviewLoop, args, {
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
    const run = await testWorkflow(reviewLoop, args, {
      agents: { implementer: reply.needsLogin(), reviewer: approved },
    });
    expect(run.stopped?.reason).toContain("login");
    expect(run.agents.map((agent) => agent.key)).not.toContain("implementer#2");
  });

  test("a reviewer that never answers stops the run", async () => {
    const run = await testWorkflow(reviewLoop, args, {
      agents: { implementer: done, reviewer: reply.silent() },
    });
    expect(run.stopped?.reason).toStartWith("reviewer unanswered:");
  });
});
