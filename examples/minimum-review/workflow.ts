import {
  defineExecutableWorkflow,
  type ExecutableWorkflow,
  isAnswered,
  type RuntimeSelection,
  type WorkflowDefinition,
  type WorkflowInvocation,
  type WorkflowMeta,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

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
  firstTurnMs?: number;
};

const DEFAULT_FIRST_TURN_MS = 5 * 60 * 1_000;

export function createMinimumReview(
  runtimes: ReviewRuntimes,
  firstTurnMs = DEFAULT_FIRST_TURN_MS,
): WorkflowDefinition<MinimumReviewArgs, MinimumReviewResult> {
  if (!Number.isSafeInteger(firstTurnMs) || firstTurnMs <= 0) {
    throw new Error("first-turn duration must be a positive safe integer");
  }
  return {
    meta: {
      name: "minimum-review",
      description: "Review one target concurrently through correctness and maintainability lenses.",
      whenToUse: "Use as the minimum end-to-end proof of isolated structured review turns.",
    },

    async run(workflow, args) {
      const reviews = await workflow.parallel(
        LENSES,
        async (lens): Promise<ReviewOutcome> => {
          const reviewer = await workflow.agents.open({
            key: `reviewer:${lens}`,
            instructions: instructionFor(lens),
            runtime: runtimes[lens],
            labels: { lens },
          });
          const { outcome } = await reviewer.run({
            timeoutMs: firstTurnMs,
            prompt: `Review target ${JSON.stringify(args.target)} using only the ${lens} lens.`,
            schema: reviewSchema(lens),
          });

          return isAnswered(outcome)
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
  };
}

export function defineReviewWorkflow(
  config: ReviewWorkflowConfig,
): ExecutableWorkflow<MinimumReviewArgs, MinimumReviewResult> {
  const { reviewers, firstTurnMs, ...meta } = config;
  const minimumReview = createMinimumReview(reviewers, firstTurnMs);
  const definition: WorkflowDefinition<MinimumReviewArgs, MinimumReviewResult> = {
    meta,
    async run(workflow, args) {
      const result = await minimumReview.run(workflow, args);
      const incomplete = result.reviews.filter((review) => review.kind === "incomplete");
      if (incomplete.length > 0) {
        throw new Error(
          `review incomplete: ${incomplete.map((review) => `${review.lens} ${review.outcome}: ${review.reason}`).join("; ")}`,
        );
      }
      return result;
    },
  };
  return defineExecutableWorkflow({
    definition,
    prepare: (invocation) => ({ target: parseReviewTarget(meta.name, invocation) }),
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
  return outputSchema(
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
