import type {
  AgentRef,
  OutputSchema,
  RuntimeAliasName,
  SpendPoolKey,
  TurnUsage,
  WorkflowContext,
  WorkflowDefinition,
} from "@wf/contract/workflow";

type RoleRuntime = { alias: RuntimeAliasName; pool: SpendPoolKey };
type AdditionalReviewer = RoleRuntime & { name: string };

type FeatureArgs = {
  ticket: string;
  cwd: string;
  runtimes: {
    planner: RoleRuntime;
    implementer: RoleRuntime;
    reviewer: RoleRuntime;
    additionalReviewers: AdditionalReviewer[];
  };
  maxRevisionRounds?: number;
};

type WorkUpdate = {
  docPath: string;
  summary: string;
  decisions: string[];
};

type ReviewVerdict =
  | { kind: "ready"; summary: string }
  | { kind: "changes-requested"; feedback: [string, ...string[]] }
  | { kind: "inconclusive"; reason: string };

type CompletedAdditionalReview =
  | { reviewer: string; kind: "ready"; summary: string }
  | { reviewer: string; kind: "changes-addressed"; feedback: [string, ...string[]] };

type Handoff = {
  docPath: string;
  summary: string;
  decisions: string[];
  review: {
    primary: string;
    additional: CompletedAdditionalReview[];
  };
};

type Stage =
  | "ticket-doc"
  | "doc-review"
  | "implementation"
  | "implementation-review"
  | "additional-review";

type FeatureOutcome =
  | {
      kind: "ready-for-user-review";
      handoff: Handoff;
    }
  | {
      kind: "deferred";
      stage: Stage;
      reason: string;
      docPath?: string;
    };

type FeatureResult = FeatureOutcome & { usage: TurnUsage[] };

type ReviewPass =
  | { kind: "ready"; summary: string; work: WorkUpdate }
  | { kind: "deferred"; reason: string; work: WorkUpdate };

declare const WORK_UPDATE: OutputSchema<WorkUpdate>;
declare const REVIEW_VERDICT: OutputSchema<ReviewVerdict>;

export const featureDelivery: WorkflowDefinition<FeatureArgs, FeatureResult> = {
  meta: {
    name: "feature-delivery",
    description: "Plan, implement, review, and prepare a feature for human review.",
    whenToUse: "Use when a ticket needs a verified plan before implementation begins.",
  },

  async run(workflow, args) {
    const result = await deliverFeature(workflow, args);
    return { ...result, usage: workflow.usage() };
  },
};

async function deliverFeature(
  workflow: WorkflowContext,
  args: FeatureArgs,
): Promise<FeatureOutcome> {
  const maxRevisions = Math.max(0, Math.floor(args.maxRevisionRounds ?? 3));
  const reviewerNames = args.runtimes.additionalReviewers.map((reviewer) => reviewer.name);
  if (new Set(reviewerNames).size !== reviewerNames.length) {
    throw new Error("feature-delivery: additional reviewer names must be unique");
  }

  const planner = await openPlanner(workflow, args);
  const reviewer = await openPrimaryReviewer(workflow, args);

  if (reviewer.execution.model === planner.execution.model) {
    return deferred(
      "doc-review",
      "The planner and primary reviewer must use different models",
    );
  }

  const planned = await planner.run({
    label: "Create ticket doc",
    prompt: `Create an implementation-ready ticket doc for ${args.ticket}.`,
    schema: WORK_UPDATE,
    nudge: true,
  });
  if (planned.outcome.kind !== "answered") {
    return deferred("ticket-doc", planned.outcome.reason);
  }

  const docReview = await reviewUntilReady(
    reviewer,
    planner,
    planned.outcome.value,
    maxRevisions,
    { kind: "ticket-doc", ticket: args.ticket },
  );
  if (docReview.kind === "deferred") {
    return deferred("doc-review", docReview.reason, docReview.work.docPath);
  }

  const implementer = await openImplementer(workflow, args);
  const implemented = await implementer.run({
    label: "Implement feature",
    prompt: [
      `Implement ${args.ticket} from ${docReview.work.docPath}.`,
      "Update that document with the decisions made and any deviations from the plan.",
    ].join("\n"),
    schema: WORK_UPDATE,
    nudge: true,
  });
  if (implemented.outcome.kind !== "answered") {
    return deferred("implementation", implemented.outcome.reason, docReview.work.docPath);
  }
  if (implemented.outcome.value.docPath !== docReview.work.docPath) {
    return deferred(
      "implementation",
      "The implementer updated a different ticket document",
      docReview.work.docPath,
    );
  }

  const implementationReview = await reviewUntilReady(
    reviewer,
    implementer,
    implemented.outcome.value,
    maxRevisions,
    { kind: "implementation" },
  );
  if (implementationReview.kind === "deferred") {
    return deferred(
      "implementation-review",
      implementationReview.reason,
      implementationReview.work.docPath,
    );
  }

  const additionalReviews = await reviewWithAdditionalAgents(
    workflow,
    args,
    implementationReview.work,
  );
  const incomplete = additionalReviews.find((review) => review.verdict.kind === "inconclusive");
  if (incomplete?.verdict.kind === "inconclusive") {
    return deferred(
      "additional-review",
      `${incomplete.reviewer}: ${incomplete.verdict.reason}`,
      implementationReview.work.docPath,
    );
  }

  const additionalFeedback = additionalReviews.flatMap((review) =>
    review.verdict.kind === "changes-requested"
      ? review.verdict.feedback.map((feedback) => `${review.reviewer}: ${feedback}`)
      : [],
  );
  let finalReview: ReviewPass = implementationReview;

  if (additionalFeedback.length > 0) {
    const revised = await implementer.run({
      label: "Apply additional review",
      prompt: [
        "Apply this additional review feedback:",
        ...additionalFeedback.map((feedback) => `- ${feedback}`),
        `Update ${implementationReview.work.docPath} with any resulting decisions.`,
      ].join("\n"),
      schema: WORK_UPDATE,
      nudge: true,
    });
    if (revised.outcome.kind !== "answered") {
      return deferred(
        "additional-review",
        revised.outcome.reason,
        implementationReview.work.docPath,
      );
    }
    if (revised.outcome.value.docPath !== implementationReview.work.docPath) {
      return deferred(
        "additional-review",
        "The implementer updated a different ticket document",
        implementationReview.work.docPath,
      );
    }

    finalReview = await reviewUntilReady(
      reviewer,
      implementer,
      revised.outcome.value,
      maxRevisions,
      { kind: "implementation", focus: additionalFeedback },
    );
    if (finalReview.kind === "deferred") {
      return deferred(
        "implementation-review",
        finalReview.reason,
        finalReview.work.docPath,
      );
    }
  }

  return {
    kind: "ready-for-user-review",
    handoff: {
      docPath: finalReview.work.docPath,
      summary: finalReview.work.summary,
      decisions: finalReview.work.decisions,
      review: {
        primary: finalReview.summary,
        additional: additionalReviews.map(completedAdditionalReview),
      },
    },
  };
}

type ReviewSubject =
  | { kind: "ticket-doc"; ticket: string }
  | { kind: "implementation"; focus?: string[] };

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
      schema: REVIEW_VERDICT,
      nudge: true,
    });
    if (review.outcome.kind !== "answered") {
      return { kind: "deferred", reason: review.outcome.reason, work };
    }
    if (review.outcome.value.kind === "ready") {
      return { kind: "ready", summary: review.outcome.value.summary, work };
    }
    if (review.outcome.value.kind === "inconclusive") {
      return { kind: "deferred", reason: review.outcome.value.reason, work };
    }
    if (revision === maxRevisions) {
      return { kind: "deferred", reason: `${name} revision limit reached`, work };
    }

    const revised = await author.run({
      label: `Revise ${name}`,
      prompt: revisionPrompt(subject, work, review.outcome.value.feedback),
      schema: WORK_UPDATE,
      nudge: true,
    });
    if (revised.outcome.kind !== "answered") {
      return { kind: "deferred", reason: revised.outcome.reason, work };
    }
    if (revised.outcome.value.docPath !== work.docPath) {
      const authorName = subject.kind === "ticket-doc" ? "planner" : "implementer";
      return {
        kind: "deferred",
        reason: `The ${authorName} updated a different ticket document`,
        work,
      };
    }
    work = revised.outcome.value;
  }

  return { kind: "deferred", reason: `${name} review did not finish`, work };
}

function reviewPrompt(subject: ReviewSubject, work: WorkUpdate): string {
  if (subject.kind === "ticket-doc") {
    return [
      `Review ${work.docPath} for ${subject.ticket}.`,
      "Return ready only when its claims are verified and someone can implement it without more research.",
    ].join("\n");
  }

  return [
    `Review the implementation described by ${work.docPath}.`,
    "Inspect the actual changes and return ready only when they are correct and complete.",
    ...(subject.focus && subject.focus.length > 0
      ? [
          "Verify that this additional feedback was resolved:",
          ...subject.focus.map((item) => `- ${item}`),
        ]
      : []),
  ].join("\n");
}

function revisionPrompt(
  subject: ReviewSubject,
  work: WorkUpdate,
  feedback: [string, ...string[]],
): string {
  return subject.kind === "ticket-doc"
    ? [
        `Revise ${work.docPath} from this review:`,
        ...feedback.map((item) => `- ${item}`),
        "Recheck the affected claims before returning.",
      ].join("\n")
    : [
        "Apply this review feedback:",
        ...feedback.map((item) => `- ${item}`),
        `Update ${work.docPath} with any resulting decisions or deviations.`,
      ].join("\n");
}

async function reviewWithAdditionalAgents(
  workflow: WorkflowContext,
  args: FeatureArgs,
  work: WorkUpdate,
) {
  return workflow.parallel(
    args.runtimes.additionalReviewers,
    async (candidate) => {
      const reviewer = await workflow.agents.open({
        key: `run:${workflow.runId}:feature:additional-reviewer:${candidate.name}`,
        cwd: args.cwd,
        instructions: "Independently review the implementation. Do not defer judgment to prior reviewers.",
        lifecycle: { retention: { kind: "workflow" } },
        runtime: { alias: candidate.alias, pool: candidate.pool },
        labels: { role: "additional-reviewer", reviewer: candidate.name },
      });
      const { outcome } = await reviewer.run({
        label: `Review implementation: ${candidate.name}`,
        prompt: `Review the implementation described by ${work.docPath}. Inspect the actual changes.`,
        schema: REVIEW_VERDICT,
        nudge: true,
      });
      const verdict: ReviewVerdict =
        outcome.kind === "answered"
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

function openPlanner(workflow: WorkflowContext, args: FeatureArgs) {
  return workflow.agents.open({
    key: `run:${workflow.runId}:feature:planner`,
    cwd: args.cwd,
    instructions: "Own the ticket document. Verify current behavior and keep the document implementation-ready.",
    lifecycle: { retention: { kind: "workflow" } },
    runtime: { alias: args.runtimes.planner.alias, pool: args.runtimes.planner.pool },
    skills: ["ticket-doc"],
    labels: { role: "planner", ticket: args.ticket },
  });
}

function openImplementer(workflow: WorkflowContext, args: FeatureArgs) {
  return workflow.agents.open({
    key: `run:${workflow.runId}:feature:implementer`,
    cwd: args.cwd,
    instructions: "Implement the approved ticket doc and keep it current as the decision record.",
    lifecycle: { retention: { kind: "workflow" } },
    runtime: { alias: args.runtimes.implementer.alias, pool: args.runtimes.implementer.pool },
    labels: { role: "implementer", ticket: args.ticket },
  });
}

function openPrimaryReviewer(workflow: WorkflowContext, args: FeatureArgs) {
  return workflow.agents.open({
    key: `run:${workflow.runId}:feature:reviewer`,
    cwd: args.cwd,
    instructions: "Gate both the ticket doc and implementation. Be specific when requesting changes.",
    lifecycle: { retention: { kind: "workflow" } },
    runtime: { alias: args.runtimes.reviewer.alias, pool: args.runtimes.reviewer.pool },
    labels: { role: "reviewer", ticket: args.ticket },
  });
}

function deferred(
  stage: Stage,
  reason: string,
  docPath?: string,
): FeatureOutcome {
  return docPath
    ? { kind: "deferred", stage, reason, docPath }
    : { kind: "deferred", stage, reason };
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
