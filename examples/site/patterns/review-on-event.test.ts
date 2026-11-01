import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import reviewOnEvent, { Review } from "./review-on-event";

const opened = { name: "mr.changes" as const, data: { mr: 42, base: "main", head: "aaa111" } };
const pushed = { name: "mr.changes" as const, data: { mr: 42, base: "main", head: "bbb222" } };
const approved = answer(Review, { approved: true, findings: [] });

describe("review on event", () => {
  test("an opened merge request is reviewed once, and the run parks until the next push", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: { reviewer: approved },
    });
    expect(run.turnsOf("reviewer")[0]?.prompt).toContain("git diff main...aaa111");
    expect(run.stages.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ["review-aaa111", "succeeded"],
    ]);
    expect(run.parked?.label).toBe("waiting for a push");
  });

  test("a push during a review is reviewed next, in the same session", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: {
        reviewer: [answer(Review, { approved: false, findings: ["off by one"] }), approved],
      },
      events: [{ during: "reviewer#1", ...pushed }],
    });
    expect(run.turnsOf("reviewer").map((turn) => turn.prompt)).toEqual([
      expect.stringContaining("aaa111"),
      expect.stringContaining("bbb222"),
    ]);
    expect(run.stages.map(({ stage }) => stage)).toEqual(["review-aaa111", "review-bbb222"]);
  });

  test("closing the merge request cancels the review under way and ends the run", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: { reviewer: reply.hang() },
      events: [{ during: "reviewer#1", name: "mr.closed", data: { mr: 42, merged: true } }],
    });
    expect(run.value).toEqual({ mr: 42, merged: true });
    expect(run.stages).toEqual([]);
  });

  test("a failed review is logged, and the next push goes to a new reviewer", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: { reviewer: reply.failed(), "reviewer#2": approved },
      events: [{ during: "reviewer#1", ...pushed }],
    });
    expect(run.logs.map((log) => log.message)).toEqual(["review failed"]);
    expect(run.turnsOf("reviewer#2")[0]?.prompt).toContain("bbb222");
    expect(run.stages.map(({ stage }) => stage)).toEqual(["review-bbb222"]);
  });
});
