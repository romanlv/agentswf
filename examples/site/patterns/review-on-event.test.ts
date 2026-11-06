import { describe, expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import reviewOnEvent, { Review } from "./review-on-event";

const opened = {
  name: "mr.changes" as const,
  data: { mr: 42, base: "main", head: "aaa1111" },
};
const pushed = {
  name: "mr.changes" as const,
  data: { mr: 42, base: "main", head: "bbb2222" },
};
const approved = answer(Review, { approved: true, findings: [] });

describe("review on event", () => {
  test("an opened merge request is reviewed once, and the run parks until the next push", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: { reviewer: approved },
    });
    expect(run.turnsOf("reviewer")[0]?.prompt).toContain(
      "git diff main...aaa1111",
    );
    expect(run.stages.map(({ name, outcome }) => [name, outcome])).toEqual([
      ["review-aaa1111", "succeeded"],
    ]);
    expect(run.ending).toMatchObject({
      kind: "parked",
      label: "waiting for a push",
    });
  });

  test("a push during a review is reviewed next, in the same session", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: {
        reviewer: [
          answer(Review, { approved: false, findings: ["off by one"] }),
          approved,
        ],
      },
      events: [{ during: "reviewer#1", ...pushed }],
    });
    expect(run.turnsOf("reviewer").map((turn) => turn.prompt)).toEqual([
      expect.stringContaining("aaa1111"),
      expect.stringContaining("bbb2222"),
    ]);
    expect(run.stages.map(({ name }) => name)).toEqual([
      "review-aaa1111",
      "review-bbb2222",
    ]);
  });

  test("closing the merge request cancels the review under way and ends the run", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: { reviewer: noAnswer.hang() },
      events: [
        {
          during: "reviewer#1",
          name: "mr.closed",
          data: { mr: 42, merged: true },
        },
      ],
    });
    expect(run.value).toEqual({ mr: 42, merged: true });
    expect(run.stages).toEqual([]);
  });

  test("a failed review is logged, and the run parks until the next push reopens the reviewer", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: opened,
      agents: { reviewer: noAnswer.failed() },
      events: [{ during: "reviewer#1", ...pushed }],
    });
    expect(run.logs.map((log) => log.message)).toEqual(["review failed"]);
    expect(run.turnsOf("reviewer")).toHaveLength(1);
    expect(run.stages).toEqual([]);
    expect(run.ending).toMatchObject({
      kind: "parked",
      label: "waiting for a push",
    });

    const woken = await testWorkflow(reviewOnEvent, {
      id: "42",
      earlier: { events: run.events, run: run.run },
      event: {
        ...pushed,
        data: { ...pushed.data, head: "ccc3333" },
        eventId: "push-ccc3333",
      },
      agents: { reviewer: approved },
    });
    expect(woken.turnsOf("reviewer")[0]?.prompt).toContain("ccc3333");
    expect(woken.stages.map(({ name }) => name)).toEqual(["review-ccc3333"]);
  });

  test("a head that isn't a commit hash is logged and not reviewed", async () => {
    const run = await testWorkflow(reviewOnEvent, {
      id: "42",
      event: {
        name: "mr.changes",
        data: { mr: 42, base: "main", head: "Feature/X" },
      },
    });
    expect(run.logs.map((log) => log.message)).toEqual(["not a commit hash"]);
    expect(run.turns).toEqual([]);
    expect(run.ending).toMatchObject({
      kind: "parked",
      label: "waiting for a push",
    });
  });
});
