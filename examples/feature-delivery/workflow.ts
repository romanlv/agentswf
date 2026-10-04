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
  type Reviewed,
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

type ConcludedVerdict = Exclude<ReviewVerdict, { kind: "inconclusive" }>;

export const featureDelivery: WorkflowDefinition<FeatureArgs, Handoff> = {
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
async function deliverFeature(workflow: WorkflowContext, args: FeatureArgs): Promise<Handoff> {
  const maxRevisions = Math.max(0, Math.floor(args.maxRevisionRounds ?? 3));
  const reviewerNames = args.runtimes.additionalReviewers.map((reviewer) => reviewer.name);
  if (new Set(reviewerNames).size !== reviewerNames.length) {
    throw new Error("feature-delivery: additional reviewer names must be unique");
  }

  // Opening an agent between stages is cheap; each attempt opens them afresh.
  const planner = await openFeatureAgent(workflow, args, "planner");
  const reviewer = await openFeatureAgent(workflow, args, "reviewer");
  if (reviewer.execution.model === planner.execution.model) {
    throw new Error("feature-delivery: the planner and primary reviewer must use different models");
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
    () =>
      reviewUntilReady(workflow, reviewer, planner, planned, maxRevisions, {
        kind: "ticket-doc",
        ticket: args.ticket,
      }),
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
      return sameDoc(workflow, outcome.value, docPath, "implementer");
    },
  );

  const implementationReview = await workflow.stage(
    "implementation-review",
    { result: REVIEWED_SCHEMA, summary: (reviewed) => reviewed.summary },
    () =>
      reviewUntilReady(workflow, reviewer, implementer, implemented, maxRevisions, {
        kind: "implementation",
        ticket: args.ticket,
      }),
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
      const additional: CompletedAdditionalReview[] = [];
      for (const { reviewer, verdict } of reviews) {
        if (verdict.kind === "inconclusive") return workflow.stop(`${reviewer}: ${verdict.reason}`);
        additional.push(completedAdditionalReview(reviewer, verdict));
      }
      const feedback = additional.flatMap((review) =>
        review.kind === "changes-addressed"
          ? review.feedback.map((line) => `${review.reviewer}: ${line}`)
          : [],
      );
      if (feedback.length === 0) return { final: implementationReview, additional };

      const subject: ReviewSubject = { kind: "implementation", ticket: args.ticket };
      const revised = await implementer.run({
        label: "Apply additional review",
        prompt: revisionPrompt(subject, implementationReview.work, feedback),
        schema: WORK_UPDATE_SCHEMA,
      });
      if (!isAnswered(revised.outcome)) return workflow.stop(revised.outcome.reason);
      const work = sameDoc(workflow, revised.outcome.value, docPath, "implementer");
      const final = await reviewUntilReady(workflow, reviewer, implementer, work, maxRevisions, {
        ...subject,
        focus: feedback,
      });
      return { final, additional };
    },
  );

  return {
    docPath: final.work.docPath,
    summary: final.work.summary,
    decisions: final.work.decisions,
    review: { primary: final.summary, additional },
  };
}

/** Reviews and revises until the reviewer approves, or stops with why it couldn't. */
async function reviewUntilReady(
  workflow: WorkflowContext,
  reviewer: AgentRef,
  author: AgentRef,
  initial: WorkUpdate,
  maxRevisions: number,
  subject: ReviewSubject,
): Promise<Reviewed> {
  let work = initial;
  const name = subject.kind === "ticket-doc" ? "ticket doc" : "implementation";
  const authorRole = subject.kind === "ticket-doc" ? "planner" : "implementer";

  for (let revision = 0; ; revision += 1) {
    const review = await reviewer.run({
      label: `Review ${name}`,
      prompt: reviewPrompt(subject, work),
      schema: REVIEW_VERDICT_SCHEMA,
    });
    if (!isAnswered(review.outcome)) return workflow.stop(review.outcome.reason);
    const verdict = review.outcome.value;
    if (verdict.kind === "ready") return { summary: verdict.summary, work };
    if (verdict.kind === "inconclusive") return workflow.stop(verdict.reason);
    if (revision === maxRevisions) return workflow.stop(`${name} revision limit reached`);

    const revised = await author.run({
      label: `Revise ${name}`,
      prompt: revisionPrompt(subject, work, verdict.feedback),
      schema: WORK_UPDATE_SCHEMA,
    });
    if (!isAnswered(revised.outcome)) return workflow.stop(revised.outcome.reason);
    work = sameDoc(workflow, revised.outcome.value, work.docPath, authorRole);
  }
}

function sameDoc(
  workflow: WorkflowContext,
  work: WorkUpdate,
  docPath: string,
  role: PrimaryRole,
): WorkUpdate {
  return work.docPath === docPath
    ? work
    : workflow.stop(`The ${role} updated a different ticket document`);
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
        prompt: reviewPrompt({ kind: "implementation", ticket }, work),
        schema: REVIEW_VERDICT_SCHEMA,
      });
      const verdict: ReviewVerdict = isAnswered(outcome)
        ? outcome.value
        : { kind: "inconclusive", reason: outcome.reason };
      return { reviewer: candidate.name, verdict };
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

function completedAdditionalReview(
  reviewer: string,
  verdict: ConcludedVerdict,
): CompletedAdditionalReview {
  return verdict.kind === "ready"
    ? { reviewer, kind: "ready", summary: verdict.summary }
    : { reviewer, kind: "changes-addressed", feedback: verdict.feedback };
}
