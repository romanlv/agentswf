import {
  type AgentRef,
  isAnswered,
  type RuntimeSelection,
  type SkillRef,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { type ReviewSubject, reviewPrompt, revisionPrompt } from "./prompts";
import {
  ADDITIONAL_SCHEMA,
  type CompletedAdditionalReview,
  REVIEW_VERDICT_SCHEMA,
  REVIEWED_SCHEMA,
  type ReviewVerdict,
  WORK_UPDATE_SCHEMA,
  type WorkUpdate,
} from "./schema";

const ROLE_CONFIG = {
  planner: {
    instructions:
      "Own the ticket document. Verify current behavior and keep the document implementation-ready.",
    skills: [{ path: new URL("./skills/ticket-doc", import.meta.url) }],
  },
  implementer: {
    instructions: "Implement the approved ticket doc and keep it current as the decision record.",
  },
  reviewer: {
    instructions:
      "Gate both the ticket doc and implementation. Be specific when requesting changes.",
  },
} satisfies Record<string, { instructions: string; skills?: SkillRef[] }>;

type PrimaryRole = keyof typeof ROLE_CONFIG;
type AdditionalReviewer = { name: string; runtime: RuntimeSelection };
type FeatureRuntimes = Record<PrimaryRole, RuntimeSelection> & {
  additionalReviewers: AdditionalReviewer[];
};

type FeatureArgs = {
  ticket: string;
  runtimes: FeatureRuntimes;
  maxRevisionRounds?: number;
};

type Handoff = {
  docPath: string;
  summary: string;
  decisions: string[];
  review: {
    primary: string;
    additional: CompletedAdditionalReview[];
  };
};

type FeatureOutcome = { kind: "ready-for-user-review"; handoff: Handoff };

type ReviewPass =
  | { kind: "ready"; summary: string; work: WorkUpdate }
  | { kind: "not-ready"; reason: string; work: WorkUpdate };

export const featureDelivery: WorkflowDefinition<FeatureArgs, FeatureOutcome> = {
  meta: {
    name: "feature-delivery",
    description: "Plan, implement, review, and prepare a feature for human review.",
    whenToUse: "Use when a ticket needs a verified plan before implementation begins.",
    version: "1.0.0",
  },

  run: (workflow, args) => deliverFeature(workflow, args),
};

/**
 * Each step is a stage, so a continue picks up at the one that stopped: a step that can't go on
 * stops inside its stage, with why, and `--continue` with the run's id redoes it. Each stage's
 * value carries what later ones need, since the agents start fresh in every attempt.
 */
async function deliverFeature(
  workflow: WorkflowContext,
  args: FeatureArgs,
): Promise<FeatureOutcome> {
  const maxRevisions = Math.max(0, Math.floor(args.maxRevisionRounds ?? 3));
  const reviewerNames = args.runtimes.additionalReviewers.map((reviewer) => reviewer.name);
  if (new Set(reviewerNames).size !== reviewerNames.length) {
    throw new Error("feature-delivery: additional reviewer names must be unique");
  }

  // Opening an agent between stages is cheap; each attempt opens them afresh.
  const planner = await openFeatureAgent(workflow, args, "planner");
  const reviewer = await openFeatureAgent(workflow, args, "reviewer");
  if (reviewer.execution.model === planner.execution.model) {
    return workflow.stop("The planner and primary reviewer must use different models");
  }

  const planned = await workflow.stage(
    "ticket-doc",
    { result: WORK_UPDATE_SCHEMA, summary: (work) => work.docPath },
    async () => {
      const { outcome } = await planner.run({
        label: "Create ticket doc",
        prompt: `Create an implementation-ready ticket doc for ${args.ticket}.`,
        schema: WORK_UPDATE_SCHEMA,
      });
      return isAnswered(outcome) ? outcome.value : workflow.stop(outcome.reason);
    },
  );

  const docReview = await workflow.stage(
    "doc-review",
    { result: REVIEWED_SCHEMA, summary: (reviewed) => reviewed.summary },
    async () => {
      const review = await reviewUntilReady(reviewer, planner, planned, maxRevisions, {
        kind: "ticket-doc",
        ticket: args.ticket,
      });
      return review.kind === "ready"
        ? { summary: review.summary, work: review.work }
        : workflow.stop(review.reason);
    },
  );
  const docPath = docReview.work.docPath;

  const implementer = await openFeatureAgent(workflow, args, "implementer");
  const implemented = await workflow.stage(
    "implementation",
    { result: WORK_UPDATE_SCHEMA, summary: (work) => work.summary },
    async () => {
      const { outcome } = await implementer.run({
        label: "Implement feature",
        prompt: [
          `Implement ${args.ticket} from ${docPath}.`,
          "Update that document with the decisions made and any deviations from the plan.",
        ].join("\n"),
        schema: WORK_UPDATE_SCHEMA,
      });
      if (!isAnswered(outcome)) return workflow.stop(outcome.reason);
      if (outcome.value.docPath !== docPath) {
        return workflow.stop("The implementer updated a different ticket document");
      }
      return outcome.value;
    },
  );

  const implementationReview = await workflow.stage(
    "implementation-review",
    { result: REVIEWED_SCHEMA, summary: (reviewed) => reviewed.summary },
    async () => {
      const review = await reviewUntilReady(reviewer, implementer, implemented, maxRevisions, {
        kind: "implementation",
        ticket: args.ticket,
      });
      return review.kind === "ready"
        ? { summary: review.summary, work: review.work }
        : workflow.stop(review.reason);
    },
  );

  const { final, additional } = await workflow.stage(
    "additional-review",
    {
      result: ADDITIONAL_SCHEMA,
      summary: ({ additional }) => `${additional.length} additional reviews`,
    },
    async () => {
      const reviews = await reviewWithAdditionalAgents(
        workflow,
        args.runtimes.additionalReviewers,
        args.ticket,
        implementationReview.work,
      );
      const incomplete = reviews.find((review) => review.verdict.kind === "inconclusive");
      if (incomplete?.verdict.kind === "inconclusive") {
        return workflow.stop(`${incomplete.reviewer}: ${incomplete.verdict.reason}`);
      }
      const feedback = reviews.flatMap((review) =>
        review.verdict.kind === "changes-requested"
          ? review.verdict.feedback.map((line) => `${review.reviewer}: ${line}`)
          : [],
      );
      const additional = reviews.map(completedAdditionalReview);
      if (feedback.length === 0) return { final: implementationReview, additional };

      const revised = await implementer.run({
        label: "Apply additional review",
        prompt: [
          `Apply this additional review feedback to your implementation of ${args.ticket}:`,
          ...feedback.map((line) => `- ${line}`),
          `Update ${docPath} with any resulting decisions.`,
        ].join("\n"),
        schema: WORK_UPDATE_SCHEMA,
      });
      if (!isAnswered(revised.outcome)) return workflow.stop(revised.outcome.reason);
      if (revised.outcome.value.docPath !== docPath) {
        return workflow.stop("The implementer updated a different ticket document");
      }
      const review = await reviewUntilReady(
        reviewer,
        implementer,
        revised.outcome.value,
        maxRevisions,
        { kind: "implementation", ticket: args.ticket, focus: feedback },
      );
      if (review.kind === "not-ready") return workflow.stop(review.reason);
      return { final: { summary: review.summary, work: review.work }, additional };
    },
  );

  return {
    kind: "ready-for-user-review",
    handoff: {
      docPath: final.work.docPath,
      summary: final.work.summary,
      decisions: final.work.decisions,
      review: { primary: final.summary, additional },
    },
  };
}

async function reviewUntilReady(
  reviewer: AgentRef,
  author: AgentRef,
  initial: WorkUpdate,
  maxRevisions: number,
  subject: ReviewSubject,
): Promise<ReviewPass> {
  let work = initial;
  const name = subject.kind === "ticket-doc" ? "ticket doc" : "implementation";

  for (let revision = 0; revision <= maxRevisions; revision += 1) {
    const review = await reviewer.run({
      label: `Review ${name}`,
      prompt: reviewPrompt(subject, work),
      schema: REVIEW_VERDICT_SCHEMA,
    });
    if (!isAnswered(review.outcome)) {
      return { kind: "not-ready", reason: review.outcome.reason, work };
    }
    if (review.outcome.value.kind === "ready") {
      return { kind: "ready", summary: review.outcome.value.summary, work };
    }
    if (review.outcome.value.kind === "inconclusive") {
      return { kind: "not-ready", reason: review.outcome.value.reason, work };
    }
    if (revision === maxRevisions) {
      return { kind: "not-ready", reason: `${name} revision limit reached`, work };
    }

    const revised = await author.run({
      label: `Revise ${name}`,
      prompt: revisionPrompt(subject, work, review.outcome.value.feedback),
      schema: WORK_UPDATE_SCHEMA,
    });
    if (!isAnswered(revised.outcome)) {
      return { kind: "not-ready", reason: revised.outcome.reason, work };
    }
    if (revised.outcome.value.docPath !== work.docPath) {
      const authorName = subject.kind === "ticket-doc" ? "planner" : "implementer";
      return {
        kind: "not-ready",
        reason: `The ${authorName} updated a different ticket document`,
        work,
      };
    }
    work = revised.outcome.value;
  }

  return { kind: "not-ready", reason: `${name} review did not finish`, work };
}

async function reviewWithAdditionalAgents(
  workflow: WorkflowContext,
  reviewers: AdditionalReviewer[],
  ticket: string,
  work: WorkUpdate,
) {
  return workflow.parallel(
    reviewers,
    async (candidate) => {
      const reviewer = await workflow.agents.open({
        key: `additional-reviewer:${candidate.name}`,
        instructions:
          "Independently review the implementation. Do not defer judgment to prior reviewers.",
        runtime: candidate.runtime,
        labels: { role: "additional-reviewer", reviewer: candidate.name },
      });
      const { outcome } = await reviewer.run({
        label: `Review implementation: ${candidate.name}`,
        prompt: `Review the implementation of ${ticket} described by ${work.docPath}. Inspect the actual changes.`,
        schema: REVIEW_VERDICT_SCHEMA,
      });
      const verdict: ReviewVerdict = isAnswered(outcome)
        ? outcome.value
        : { kind: "inconclusive", reason: outcome.reason };

      return {
        reviewer: candidate.name,
        verdict,
      };
    },
    { label: "Additional implementation reviews", concurrency: 4 },
  );
}

function openFeatureAgent(workflow: WorkflowContext, args: FeatureArgs, role: PrimaryRole) {
  const config = ROLE_CONFIG[role];
  return workflow.agents.open({
    key: role,
    instructions: config.instructions,
    runtime: args.runtimes[role],
    ...("skills" in config ? { skills: config.skills } : {}),
    labels: { role, ticket: args.ticket },
  });
}

function completedAdditionalReview(review: {
  reviewer: string;
  verdict: ReviewVerdict;
}): CompletedAdditionalReview {
  if (review.verdict.kind === "ready") {
    return { reviewer: review.reviewer, kind: "ready", summary: review.verdict.summary };
  }
  if (review.verdict.kind === "changes-requested") {
    return {
      reviewer: review.reviewer,
      kind: "changes-addressed",
      feedback: review.verdict.feedback,
    };
  }
  throw new Error(`Additional review by ${review.reviewer} is incomplete`);
}
