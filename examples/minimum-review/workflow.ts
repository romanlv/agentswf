import { typed } from "agentswf/typebox";
import {
  type Duration,
  defineWorkflow,
  duration,
  type RuntimeSelection,
  type Workflow,
  type WorkflowInvocation,
  type WorkflowMeta,
} from "agentswf/workflow";
import Type from "typebox";

const LENSES = ["correctness", "maintainability"] as const;

export type ReviewLens = (typeof LENSES)[number];

const REVIEW_FINDING_SCHEMA = Type.Object(
  {
    severity: Type.Enum(["blocking", "non-blocking"]),
    summary: Type.String(),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

const REVIEW_SCHEMA = Type.Object(
  {
    lens: Type.Enum(LENSES),
    summary: Type.String(),
    findings: Type.Array(REVIEW_FINDING_SCHEMA),
  },
  { additionalProperties: false },
);

export type ReviewFinding = Type.Static<typeof REVIEW_FINDING_SCHEMA>;
type ReviewPayload = Type.Static<typeof REVIEW_SCHEMA>;

export type AcceptedReview = ReviewPayload & {
  kind: "completed";
};

export type IncompleteReview = {
  kind: "incomplete";
  lens: ReviewLens;
  outcome: "unanswered" | "blocked" | "timed-out" | "failed" | "cancelled";
  reason: string;
};

export type ReviewOutcome = AcceptedReview | IncompleteReview;

export type MinimumReviewArgs = {
  target: string;
};

export type MinimumReviewResult = {
  reviews: ReviewOutcome[];
  blockingFindingCount: number;
};

export type ReviewRuntimes = Readonly<Record<ReviewLens, RuntimeSelection>>;

export type ReviewWorkflowConfig = WorkflowMeta & {
  reviewers: ReviewRuntimes;
  operationTimeout?: Duration;
};

export function createMinimumReview(
  runtimes: ReviewRuntimes,
  operationTimeout: Duration = "5m",
): Workflow<MinimumReviewArgs, MinimumReviewResult> {
  // A config may come from data, past what `tsc` checks.
  const timeout = duration(operationTimeout);
  return defineWorkflow<MinimumReviewArgs, MinimumReviewResult>({
    meta: {
      name: "minimum-review",
      description: "Review one target concurrently through correctness and maintainability lenses.",
    },
    prepare: (invocation) => ({ target: parseReviewTarget("minimum-review", invocation) }),

    async run(wf, args) {
      const reviews = await wf.parallel(
        LENSES,
        async (lens): Promise<ReviewOutcome> => {
          const reviewer = await wf.agents.open({
            key: `reviewer-${lens}`,
            instructions: instructionFor(lens),
            runtime: runtimes[lens],
          });
          const { outcome } = await reviewer.run({
            timeout,
            prompt: `Review target ${JSON.stringify(args.target)} using only the ${lens} lens.`,
            schema: reviewSchema(lens),
          });

          return outcome.answered
            ? { kind: "completed", ...outcome.value }
            : { kind: "incomplete", lens, outcome: outcome.kind, reason: outcome.reason };
        },
        { label: "Minimum review" },
      );

      return {
        reviews,
        blockingFindingCount: reviews.reduce(
          (count, review) =>
            review.kind === "completed"
              ? count + review.findings.filter((finding) => finding.severity === "blocking").length
              : count,
          0,
        ),
      };
    },
  });
}

export function defineReviewWorkflow(
  config: ReviewWorkflowConfig,
): Workflow<MinimumReviewArgs, MinimumReviewResult> {
  const { reviewers, operationTimeout, ...meta } = config;
  const minimumReview = createMinimumReview(reviewers, operationTimeout);
  return defineWorkflow<MinimumReviewArgs, MinimumReviewResult>({
    meta,
    prepare: (invocation) => ({ target: parseReviewTarget(meta.name, invocation) }),
    async run(wf, args) {
      const result = await minimumReview.run(wf, args);
      const incomplete = result.reviews.filter((review) => review.kind === "incomplete");
      if (incomplete.length > 0) {
        throw new Error(
          `review incomplete: ${incomplete.map((review) => `${review.lens} ${review.outcome}: ${review.reason}`).join("; ")}`,
        );
      }
      return result;
    },
  });
}

function parseReviewTarget(name: string, invocation: WorkflowInvocation): string {
  if (invocation.argv.length > 1) throw new Error(`${name} accepts at most one target`);
  const target = invocation.argv[0] ?? ".";
  if (target.trim() === "") throw new Error("review target cannot be empty");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(target)) {
    throw new Error("review target cannot contain control characters");
  }
  return target;
}

function instructionFor(lens: ReviewLens): string {
  const lensInstruction =
    lens === "correctness"
      ? "Find behavioral defects. Do not report style or architecture preferences."
      : "Find changeability and clarity problems. Do not report behavioral defects.";
  return `${lensInstruction} Perform the review yourself. Do not delegate, launch subagents, or create background agents.`;
}

/** What each lens is asked for: a review that names that lens alone. */
export function reviewSchema(lens: ReviewLens) {
  return typed(
    Type.Object(
      {
        lens: Type.Enum([lens]),
        summary: Type.String(),
        findings: Type.Array(REVIEW_FINDING_SCHEMA),
      },
      { additionalProperties: false },
    ),
  );
}
