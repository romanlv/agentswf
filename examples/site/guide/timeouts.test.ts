import { expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import timedReview, { FINDINGS } from "./timeouts";

test("both reviews answer within the budget", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    {
      agents: {
        "review-correctness": answer(FINDINGS, {
          findings: ["off by one in paging"],
        }),
        "review-tests": answer(FINDINGS, { findings: [] }),
      },
    },
  );
  expect(run.value).toEqual({ findings: ["off by one in paging"] });
});

test("a reviewer that goes quiet is nudged in the workflow's words, and answers", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    {
      agents: {
        "review-correctness": answer(FINDINGS, (turn) =>
          turn.nudge ? { findings: ["partial: paging"] } : noAnswer.silent(),
        ),
        "review-tests": answer(FINDINGS, { findings: [] }),
      },
    },
  );
  expect(run.value).toEqual({ findings: ["partial: paging"] });
  const [first, checkIn] = run.turnsOf("review-correctness");
  expect([first?.nudge, checkIn?.nudge]).toEqual([false, true]);
  expect(checkIn?.prompt).toContain("Send the findings you have so far");
});

test("a turn past its timeout ends timed-out, and the run goes on to the next", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    {
      agents: {
        "review-correctness": noAnswer.timedOut(),
        "review-tests": answer(FINDINGS, { findings: ["no test for paging"] }),
      },
    },
  );
  expect(run.value).toEqual({ findings: ["no test for paging"] });
});

test("no answer at all stops the run on purpose, saying why", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 20 },
    { agents: { "review-*": noAnswer.silent() } },
  );
  expect(run.ending).toMatchObject({
    kind: "stopped",
    reason: "no review answered: unanswered, unanswered",
  });
});

test("past the parallel timeout, the review stops instead of failing", async () => {
  const run = await testWorkflow(
    timedReview,
    { minutes: 0.001 },
    { agents: { "review-*": noAnswer.hang() } },
  );
  expect(run.ending).toMatchObject({
    kind: "stopped",
    reason: "the reviews took over 0.001 minutes",
  });
  // One at a time: the second review never started.
  expect(run.turnsOf("review-tests")).toHaveLength(0);
});
