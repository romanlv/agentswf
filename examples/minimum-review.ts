import type {
  ExecutableWorkflow,
  OutputSchema,
  RuntimeSelection,
  TurnUsage,
  WorkflowDefinition,
  WorkflowInvocation,
} from "@wf/contract/workflow";
import {
  defineExecutableWorkflow,
  EXECUTABLE_WORKFLOW_KIND,
} from "@wf/contract/workflow";

export type ReviewLens = "correctness" | "maintainability";

export type ReviewFinding = {
  severity: "blocking" | "non-blocking";
  summary: string;
  evidence: string;
};

export type AcceptedReview = {
  kind: "completed";
  lens: ReviewLens;
  summary: string;
  findings: ReviewFinding[];
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
  usage: TurnUsage[];
};

const LENSES: readonly ReviewLens[] = ["correctness", "maintainability"];

export type ReviewRuntimes = Readonly<Record<ReviewLens, RuntimeSelection>>;

export type ReviewWorkflowConfig = {
  name: string;
  description: string;
  whenToUse?: string;
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
            deadline: workflow.deadline,
            instructions: instructionFor(lens),
            lifecycle: { retention: { kind: "workflow" } },
            runtime: runtimes[lens],
            labels: { lens },
          });
          const { outcome } = await reviewer.run({
            id: `review:${lens}`,
            deadline: firstTurnDeadline(workflow.deadline, firstTurnMs),
            prompt: `Review target ${JSON.stringify(args.target)} using only the ${lens} lens.`,
            schema: reviewSchema(lens),
            nudge: { deadline: workflow.deadline },
          });

          return outcome.kind === "answered"
            ? { kind: "completed", ...outcome.value }
            : { kind: "incomplete", lens, outcome: outcome.kind, reason: outcome.reason };
        },
        { label: "Minimum review", concurrency: 2, deadline: workflow.deadline },
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
        usage: workflow.usage(),
      };
    },
  };
}

export function defineReviewWorkflow(
  config: ReviewWorkflowConfig,
): ExecutableWorkflow<MinimumReviewArgs, MinimumReviewResult> {
  const minimumReview = createMinimumReview(config.reviewers, config.firstTurnMs);
  const definition: WorkflowDefinition<MinimumReviewArgs, MinimumReviewResult> = {
    meta: {
      name: config.name,
      description: config.description,
      ...(config.whenToUse ? { whenToUse: config.whenToUse } : {}),
    },
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
    kind: EXECUTABLE_WORKFLOW_KIND,
    definition,
    prepare: (invocation) => ({ target: parseReviewTarget(config.name, invocation) }),
  });
}

function firstTurnDeadline(
  workflowDeadline: { unixMilliseconds: number },
  firstTurnMs: number,
): { unixMilliseconds: number } {
  return {
    unixMilliseconds: Math.min(
      workflowDeadline.unixMilliseconds,
      Date.now() + firstTurnMs,
    ),
  };
}

function parseReviewTarget(name: string, invocation: WorkflowInvocation): string {
  if (invocation.argv.length > 1) throw new Error(`${name} accepts at most one target`);
  const target = invocation.argv[0] ?? ".";
  if (target.trim() === "") throw new Error("review target cannot be empty");
  if (/[\u0000-\u001f\u007f]/.test(target)) {
    throw new Error("review target cannot contain control characters");
  }
  return target;
}

function instructionFor(lens: ReviewLens): string {
  const lensInstruction = lens === "correctness"
    ? "Find behavioral defects. Do not report style or architecture preferences."
    : "Find changeability and clarity problems. Do not report behavioral defects.";
  return `${lensInstruction} Perform the review yourself. Do not delegate, launch subagents, or create background agents.`;
}

function reviewSchema(lens: ReviewLens): OutputSchema<Omit<AcceptedReview, "kind">> {
  return {
    jsonSchema: {
      type: "object",
      properties: {
        lens: { type: "string", enum: [lens] },
        summary: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["blocking", "non-blocking"] },
              summary: { type: "string" },
              evidence: { type: "string" },
            },
            required: ["severity", "summary", "evidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["lens", "summary", "findings"],
      additionalProperties: false,
    },
  };
}
