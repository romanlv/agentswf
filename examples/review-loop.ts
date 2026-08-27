import type {
  OutputSchema,
  RuntimeAliasName,
  SpendPoolKey,
  TurnUsage,
  WorkflowContext,
  WorkflowDefinition,
} from "@wf/contract/workflow";

type Role = "reviewer" | "publisher";

type MergeRequest = {
  iid: number;
  title: string;
  head: string;
  publicationAuthorized: boolean;
};

type ReviewVerdict =
  | { kind: "no-blocking-findings"; summary: string }
  | { kind: "blocking-findings"; findingIds: string[] }
  | { kind: "inconclusive"; reason: string };

type CompletedReview = {
  ledgerPath: string;
  head: string;
  verdict: ReviewVerdict;
  findingIdsToPublish: string[];
};

type ReviewState =
  | { kind: "unreviewed" }
  | { kind: "invalid"; errors: string[] }
  | {
      kind: "reviewed";
      review: CompletedReview;
      openFindings: number;
      synced: boolean;
    };

type DiscussionState =
  | { kind: "not-read" }
  | { kind: "available"; version: string; digest: string }
  | { kind: "unavailable"; reason: string };

type ReviewerTask =
  | { kind: "review.first" }
  | { kind: "review.followup"; from: string; to: string }
  | { kind: "ledger.repair"; errors: string[] };

type PublisherTask = {
  kind: "gitlab.sync";
  reason: string;
  review: CompletedReview;
};

type Plan =
  | { kind: "review"; turnId: string; task: ReviewerTask }
  | { kind: "publish"; turnId: string; task: PublisherTask }
  | { kind: "observe"; need: "discussions" }
  | { kind: "idle" }
  | { kind: "defer"; reason: string };

type ReviewerTurnResult =
  | { kind: "reviewed"; review: CompletedReview }
  | { kind: "repaired"; ledgerPath: string };

type PublisherTurnResult = {
  kind: "synced";
  ledgerPath: string;
  head: string;
};

type RoleRuntime = { alias: RuntimeAliasName; pool: SpendPoolKey };

type TickArgs = {
  runtimes: Record<Role, RoleRuntime>;
};

type CompletedStatus = "reviewed" | "repaired" | "synced";

type TickSummary = {
  completed: Array<{ iid: number; status: CompletedStatus }>;
  deferred: Array<{ iid: number; reason: string }>;
};

type TickResult = TickSummary & { usage: TurnUsage[] };

interface ReviewLoopActivities {
  listEligibleMergeRequests(): Promise<MergeRequest[]>;
  readMergeRequest(iid: number): Promise<MergeRequest>;
  readReview(iid: number): Promise<ReviewState>;
  readDiscussions(iid: number): Promise<DiscussionState>;
  plan(mr: MergeRequest, review: ReviewState, discussions: DiscussionState): Plan;
  renderReviewerPrompt(mr: MergeRequest, task: ReviewerTask): string;
  renderPublisherPrompt(mr: MergeRequest, task: PublisherTask): string;
}

declare const REVIEWER_RESULT: OutputSchema<ReviewerTurnResult>;
declare const PUBLISHER_RESULT: OutputSchema<PublisherTurnResult>;

export function reviewLoop(
  activities: ReviewLoopActivities,
): WorkflowDefinition<TickArgs, TickResult> {
  return {
    meta: {
      name: "review-loop-tick",
      description: "Review eligible merge requests, then publish completed reviews when authorized.",
      whenToUse: "Use for recurring reviews with durable ledgers and explicit publication handoffs.",
    },

    async run(workflow, args) {
      const mergeRequests = await activities.listEligibleMergeRequests();

      const outcomes = await workflow.parallel(
        mergeRequests,
        (mr) =>
          processMergeRequest(workflow, activities, args.runtimes, mr).catch(
            (error): MergeRequestResult => ({ deferred: message(error) }),
          ),
        { label: "Review merge requests", concurrency: 8 },
      );
      const reviewersToCompact = mergeRequests.filter((_, index) => outcomes[index]?.reviewerRan);
      const compactions = await workflow.parallel(
        reviewersToCompact,
        (mr) =>
          compactReviewer(workflow, args.runtimes.reviewer, mr).catch((error) => ({
            deferred: `compaction: ${message(error)}`,
          })),
        { label: "Compact reviewers", concurrency: 8 },
      );

      const result = outcomes.reduce<TickSummary>(
        (result, outcome, index) => {
          const mr = mergeRequests[index];
          if (!mr) return result;
          for (const status of outcome.completed ?? []) {
            result.completed.push({ iid: mr.iid, status });
          }
          if (outcome.deferred) {
            result.deferred.push({ iid: mr.iid, reason: outcome.deferred });
          }
          return result;
        },
        { completed: [], deferred: [] },
      );
      compactions.forEach((compaction, index) => {
        if (compaction.deferred) {
          const mr = reviewersToCompact[index];
          if (mr) result.deferred.push({ iid: mr.iid, reason: compaction.deferred });
        }
      });
      return { ...result, usage: workflow.usage() };
    },
  };
}

type MergeRequestResult = {
  completed?: CompletedStatus[];
  deferred?: string;
  reviewerRan?: true;
};

async function processMergeRequest(
  workflow: WorkflowContext,
  activities: ReviewLoopActivities,
  runtimes: Record<Role, RoleRuntime>,
  mr: MergeRequest,
): Promise<MergeRequestResult> {
  const review = await activities.readReview(mr.iid);
  const plan = await resolvePlan(activities, mr, review);

  if (plan.kind === "idle") return {};
  if (plan.kind === "defer") return { deferred: plan.reason };
  if (plan.kind === "publish") {
    return publishReview(workflow, activities, runtimes.publisher, mr, plan.turnId, plan.task);
  }

  const reviewer = await openAgent(workflow, runtimes.reviewer, mr, "reviewer");
  const { outcome } = await reviewer.run({
    id: plan.turnId,
    label: `${mr.iid} ${plan.task.kind}`,
    prompt: activities.renderReviewerPrompt(mr, plan.task),
    schema: REVIEWER_RESULT,
  });

  if (outcome.kind !== "answered") {
    return { deferred: outcome.reason, reviewerRan: true };
  }
  if (outcome.value.kind === "repaired") {
    return {
      completed: ["repaired"],
      reviewerRan: true,
    };
  }

  const reviewResult = outcome.value.review;
  if (reviewResult.head !== mr.head) {
    return {
      deferred: `review completed at ${reviewResult.head}, expected ${mr.head}`,
      reviewerRan: true,
    };
  }
  let publication: MergeRequestResult;
  try {
    publication = await publishReview(
      workflow,
      activities,
      runtimes.publisher,
      mr,
      `${plan.turnId}:publish`,
      { kind: "gitlab.sync", reason: "review completed", review: reviewResult },
    );
  } catch (error) {
    return {
      completed: ["reviewed"],
      deferred: message(error),
      reviewerRan: true,
    };
  }
  return {
    ...publication,
    completed: ["reviewed", ...(publication.completed ?? [])],
    reviewerRan: true,
  };
}

async function publishReview(
  workflow: WorkflowContext,
  activities: ReviewLoopActivities,
  runtime: RoleRuntime,
  mr: MergeRequest,
  turnId: string,
  task: PublisherTask,
): Promise<MergeRequestResult> {
  const current = await activities.readMergeRequest(mr.iid);
  const blocked = publicationBlocker(current, task.review);
  if (blocked) return { deferred: blocked };

  const publisher = await openAgent(workflow, runtime, current, "publisher");
  const { outcome } = await publisher.run({
    id: turnId,
    label: `${current.iid} ${task.kind}`,
    prompt: activities.renderPublisherPrompt(current, task),
    schema: PUBLISHER_RESULT,
  });

  if (outcome.kind !== "answered") return { deferred: outcome.reason };

  const mismatch = syncMismatch(outcome.value, task.review);
  return mismatch ? { deferred: mismatch } : { completed: ["synced"] };
}

function publicationBlocker(mr: MergeRequest, review: CompletedReview): string | null {
  if (review.head !== mr.head) {
    return `review completed at ${review.head}, current head is ${mr.head}`;
  }
  if (review.verdict.kind === "inconclusive") return review.verdict.reason;
  return mr.publicationAuthorized ? null : "GitLab publication is not authorized";
}

function syncMismatch(result: PublisherTurnResult, review: CompletedReview): string | null {
  if (result.head !== review.head) {
    return `publisher synced ${result.head}, expected ${review.head}`;
  }
  return result.ledgerPath === review.ledgerPath
    ? null
    : "publisher synced a different review ledger";
}

function openAgent(
  workflow: WorkflowContext,
  runtime: RoleRuntime,
  mr: MergeRequest,
  role: Role,
) {
  return workflow.agents.open({
    key: agentKey(mr.iid, role),
    instructions:
      role === "reviewer"
        ? "Own review judgment and the ledger. Return the final verdict, but do not publish it."
        : "Publish the completed review without changing its verdict or formal review state.",
    lifecycle:
      role === "reviewer"
        ? {
            retention: { kind: "idle" as const, milliseconds: 24 * 60 * 60 * 1_000 },
            recovery: { onCrash: "resume-or-replace" as const, maxRestarts: 2 },
          }
        : { retention: { kind: "workflow" as const } },
    runtime,
    labels: { iid: mr.iid, role },
  });
}

async function compactReviewer(
  workflow: WorkflowContext,
  runtime: RoleRuntime,
  mr: MergeRequest,
): Promise<{ deferred?: string }> {
  const reviewer = await workflow.agents.attach(agentKey(mr.iid, "reviewer"), runtime);
  if (!reviewer) return {};

  const outcome = await reviewer.compact({
    id: `tick:${workflow.runId}`,
    prompt: "Compact for the next tick. Treat the ledger and GitLab as authoritative.",
  });
  return outcome.kind === "answered" ? {} : { deferred: `compaction: ${outcome.reason}` };
}

function agentKey(iid: number, role: Role): string {
  return `mr:${iid}:${role}`;
}

async function resolvePlan(
  activities: ReviewLoopActivities,
  mr: MergeRequest,
  review: ReviewState,
): Promise<Exclude<Plan, { kind: "observe" }>> {
  const unread: DiscussionState = { kind: "not-read" };
  const first = activities.plan(mr, review, unread);
  if (first.kind !== "observe") return first;

  const discussions = await activities.readDiscussions(mr.iid);
  const resolved = activities.plan(mr, review, discussions);
  if (resolved.kind === "observe") {
    return { kind: "defer", reason: "planner requested discussions after they were read" };
  }
  return resolved;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
