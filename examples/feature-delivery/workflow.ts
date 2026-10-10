// One ticket from plan to approved change:
//
// ticket-doc ─▶ doc-review ⟲ ─▶ implementation ─▶ implementation-review ⟲ ─▶ additional-review
//  planner       reviewer asks,     implementer      reviewer asks,              with --reviewer: more
//  writes it     planner revises    builds it        implementer revises         reviewers at once; the
//                                                                                implementer fixes what
//                                                                                they ask, reviewer ⟲
//
// The reviewer runs on another model than the planner. The run stops when an agent gives no
// answer, an author moves the ticket doc, a reviewer can't decide, or a review still wants changes
// after `--revisions` revisions (3 by default). `--continue {ticket}` keeps the stages that finished
// and redoes the one that stopped, with fresh agents: each stage's value carries what later stages
// need, and each prompt says all its agent needs to know.
//
// awf run --run-root {outside the repo} examples/feature-delivery/workflow.ts -- ABC-1
//   [--revisions 3] [--reviewer security=claude]…
// The planner's skill is copied into the run's records, and claude takes no skill from inside its
// working directory, so the records go outside the repo.
import { defineExecutableWorkflow, type WorkflowContext } from "@agentswf/contract/workflow";
import { parseArgs } from "./cli";
import { md } from "./prompt";
import {
  additionalReviews,
  implementation,
  requestedChanges,
  reviewLoop,
  tally,
  ticketDoc,
  workOn,
} from "./reviews";
import { ADDITIONAL, type FeatureArgs, type Handoff, REVIEWED, WORK } from "./schema";
import { openTeam } from "./team";

async function deliverFeature(workflow: WorkflowContext, args: FeatureArgs): Promise<Handoff> {
  const { ticket } = args;
  const team = await openTeam(workflow, args);
  const { planner, reviewer } = team;
  const reviewUntilApproved = reviewLoop(workflow, reviewer, args.maxRevisions);

  const plan = await workflow.stage(
    "ticket-doc",
    { result: WORK, summary: (work) => work.docPath },
    () =>
      planner.ask(WORK, {
        label: "Create ticket doc",
        prompt: md`Create an implementation-ready ticket doc for ${ticket}.`,
      }),
  );

  const approvedPlan = await workflow.stage(
    "doc-review",
    { result: REVIEWED, summary: (review) => review.summary },
    () => reviewUntilApproved(planner, plan, ticketDoc(ticket)),
  );
  const { docPath } = approvedPlan.work;

  const implementer = await team.implementer();
  const built = await workflow.stage(
    "implementation",
    { result: WORK, summary: (work) => work.summary },
    () =>
      workOn(implementer, docPath, {
        label: "Implement feature",
        prompt: md`
          Implement ${ticket} from ${docPath}.
          Update that document with the decisions made and any deviations from the plan.
        `,
      }),
  );

  const approvedBuild = await workflow.stage(
    "implementation-review",
    { result: REVIEWED, summary: (review) => review.summary },
    () => reviewUntilApproved(implementer, built, implementation(ticket)),
  );

  const { final, additional } = await workflow.stage(
    "additional-review",
    { result: ADDITIONAL, summary: ({ additional }) => tally(additional) },
    async () => {
      const additional = await additionalReviews(
        workflow,
        args,
        team.additionalReviewer,
        approvedBuild.work,
      );
      const asked = requestedChanges(additional);
      if (asked.length === 0) return { final: approvedBuild, additional };

      const fixed = await workOn(implementer, docPath, {
        label: "Apply additional review",
        prompt: implementation(ticket).revise(approvedBuild.work, asked),
      });
      const final = await reviewUntilApproved(implementer, fixed, implementation(ticket, asked));
      return { final, additional };
    },
  );

  return {
    docPath,
    summary: final.work.summary,
    decisions: final.work.decisions,
    review: { primary: final.summary, additional },
  };
}

const executable = defineExecutableWorkflow<FeatureArgs, Handoff>({
  definition: {
    meta: {
      name: "feature-delivery",
      description: "Plan, implement, review, and prepare a feature for human review.",
      whenToUse: "Use when a ticket needs a verified plan before implementation begins.",
      version: "1.0.0",
    },
    run: deliverFeature,
  },
  prepare: ({ argv }) => parseArgs(argv),
  id: (args) => args.ticket,
  present: ({ docPath, summary, review }) =>
    [summary, docPath, tally(review.additional)].join("\n"),
});

export const featureDelivery = executable.definition;
export default executable;
