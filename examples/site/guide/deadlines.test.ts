import { expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import timedReview, { FINDINGS } from "./deadlines";

test("both reviews answer within the budget", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    {
      agents: {
        "review:correctness": answer(FINDINGS, { findings: ["off by one in paging"] }),
        "review:tests": answer(FINDINGS, { findings: [] }),
      },
    },
  );
  expect(run.value).toEqual({ findings: ["off by one in paging"] });
});

test("a reviewer that goes quiet is checked in on with the workflow's words, and answers", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    {
      agents: {
        "review:correctness": answer(FINDINGS, (turn) =>
          turn.nudge ? { findings: ["partial: paging"] } : reply.silent(),
        ),
        "review:tests": answer(FINDINGS, { findings: [] }),
      },
    },
  );
  expect(run.value).toEqual({ findings: ["partial: paging"] });
  const [first, checkIn] = run.turnsOf("review:correctness");
  expect([first?.nudge, checkIn?.nudge]).toEqual([false, true]);
  expect(checkIn?.prompt).toContain("Send the findings you have so far");
});

test("a turn past its timeoutMs ends timed-out, and the run goes on to the next", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    {
      agents: {
        "review:correctness": reply.timedOut(),
        "review:tests": answer(FINDINGS, { findings: ["no test for paging"] }),
      },
    },
  );
  expect(run.value).toEqual({ findings: ["no test for paging"] });
});

test("no answer at all stops the run on purpose, saying why", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    { agents: { "review:*": reply.silent() } },
  );
  expect(run.stopped?.reason).toBe("no review answered: unanswered, unanswered");
});

test("past the parallel deadline, the review stops instead of failing", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 0.001 },
    { agents: { "review:*": reply.hang() } },
  );
  expect(run.stopped?.reason).toBe("the reviews took over 0.001 minutes");
  // One at a time: the second review never started.
  expect(run.turnsOf("review:tests")).toHaveLength(0);
});
