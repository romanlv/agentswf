import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import reviewLoop from "./review-loop";
import { createMinimumReview, type ReviewLens, reviewSchema } from "./workflow";

const minimumReview = createMinimumReview({ correctness: "claude", maintainability: "codex" });
const args = { target: "src/report.ts" };

const nan = {
  severity: "blocking",
  summary: "Empty input renders NaN as a percentage",
  evidence: "runs.length is the divisor without an empty-input branch",
} as const;
const coupled = {
  severity: "non-blocking",
  summary: "Formatting and aggregation are coupled",
  evidence: "renderRunSummary computes groups and builds presentation text",
} as const;
const review = (lens: ReviewLens, findings: (typeof nan | typeof coupled)[]) =>
  answer(reviewSchema(lens), { lens, summary: `${lens} review complete`, findings: [...findings] });

describe("minimum-review", () => {
  test("both lenses review at once, and their reviews come back in lens order", async () => {
    // A barrier: correctness answers only after maintainability has, so both are in flight
    // together and the answers arrive out of lens order.
    const { promise: maintained, resolve: maintainabilityAnswered } = Promise.withResolvers<void>();
    const run = await testWorkflow(minimumReview, args, {
      agents: {
        "reviewer:correctness": answer(reviewSchema("correctness"), async () => {
          await maintained;
          return { lens: "correctness", summary: "correctness review complete", findings: [nan] };
        }),
        "reviewer:maintainability": answer(reviewSchema("maintainability"), () => {
          maintainabilityAnswered();
          return {
            lens: "maintainability",
            summary: "maintainability review complete",
            findings: [coupled],
          };
        }),
      },
    });
    expect(run.value).toEqual({
      reviews: [
        {
          kind: "completed",
          lens: "correctness",
          summary: "correctness review complete",
          findings: [nan],
        },
        {
          kind: "completed",
          lens: "maintainability",
          summary: "maintainability review complete",
          findings: [coupled],
        },
      ],
      blockingFindingCount: 1,
    });
    expect(run.turnsOf("reviewer:correctness")[0]!.prompt).toBe(
      'Review target "src/report.ts" using only the correctness lens.',
    );
    expect(run.agentOf("reviewer:correctness").labels).toEqual({ lens: "correctness" });
    expect(run.agentOf("reviewer:maintainability").labels).toEqual({ lens: "maintainability" });
    expect(run.agents.every((agent) => agent.instructions?.includes("Do not delegate"))).toBe(true);
  });

  test("a silent lens is nudged, then kept as incomplete, and counts no findings", async () => {
    const run = await testWorkflow(minimumReview, args, {
      agents: {
        "reviewer:correctness": reply.silent(),
        "reviewer:maintainability": review("maintainability", [coupled]),
      },
    });
    expect(run.value.reviews[0]).toMatchObject({
      kind: "incomplete",
      lens: "correctness",
      outcome: "unanswered",
    });
    expect(run.value.reviews[1]).toMatchObject({ kind: "completed", lens: "maintainability" });
    expect(run.value.blockingFindingCount).toBe(0);
    expect(run.turnsOf("reviewer:correctness").map((turn) => turn.nudge)).toEqual([false, true]);
  });

  test("each incomplete lens keeps its own outcome and reason", async () => {
    const failed = await testWorkflow(minimumReview, args, {
      agents: {
        "reviewer:correctness": reply.failed("correctness went failed"),
        "reviewer:maintainability": review("maintainability", [coupled]),
      },
    });
    expect(failed.value.reviews[0]).toEqual({
      kind: "incomplete",
      lens: "correctness",
      outcome: "failed",
      reason: "correctness went failed",
    });
    const run = await testWorkflow(minimumReview, args, {
      agents: {
        "reviewer:correctness": reply.timedOut("correctness went timed-out"),
        "reviewer:maintainability": reply.blocked("maintainability went blocked"),
      },
    });
    expect(run.value).toEqual({
      reviews: [
        {
          kind: "incomplete",
          lens: "correctness",
          outcome: "timed-out",
          reason: "correctness went timed-out",
        },
        {
          kind: "incomplete",
          lens: "maintainability",
          outcome: "blocked",
          reason: "maintainability went blocked",
        },
      ],
      blockingFindingCount: 0,
    });
  });

  test("a first turn's bound must be a positive whole number of milliseconds", () => {
    for (const firstTurnMs of [0, -1, 1.5]) {
      expect(() =>
        createMinimumReview({ correctness: "claude", maintainability: "codex" }, firstTurnMs),
      ).toThrow("first-turn duration must be a positive safe integer");
    }
  });

  describe("review-loop, the executable", () => {
    test("runs its lenses on the operator's claude and codex, and returns the reviews", async () => {
      const run = await testWorkflow(reviewLoop, args, {
        agents: {
          "reviewer:correctness": review("correctness", [nan]),
          "reviewer:maintainability": review("maintainability", []),
        },
      });
      expect(run.value.blockingFindingCount).toBe(1);
      expect(run.agentOf("reviewer:correctness").execution.alias).toBe("claude");
      expect(run.agentOf("reviewer:maintainability").execution.alias).toBe("codex");
    });

    test("an incomplete lens fails the run, naming it", async () => {
      const run = await testWorkflow(reviewLoop, args, {
        agents: {
          "reviewer:correctness": reply.failed("harness crashed"),
          "reviewer:maintainability": review("maintainability", []),
        },
      });
      expect(() => run.value).toThrow("review incomplete: correctness failed: harness crashed");
    });

    test("takes one target, the working tree by default, and refuses a bad one", () => {
      const prepare = (...argv: string[]) => reviewLoop.prepare({ argv, cwd: "/repo" });
      expect(prepare()).toEqual({ target: "." });
      expect(prepare("src")).toEqual({ target: "src" });
      expect(() => prepare("a", "b")).toThrow("review-loop accepts at most one target");
      expect(() => prepare(" ")).toThrow("review target cannot be empty");
      expect(() => prepare("a\nb")).toThrow("review target cannot contain control characters");
    });
  });
});
