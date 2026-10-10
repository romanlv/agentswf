import type { WorkflowContext } from "@agentswf/contract/workflow";
import { list, md } from "./prompt";
import {
  type AdditionalReview,
  type AdditionalReviewer,
  type FeatureArgs,
  type Reviewed,
  VERDICT,
  WORK,
  type WorkUpdate,
} from "./schema";
import type { Session } from "./session";

/** What a review is of: its name, and what the reviewer and the author are told. */
export type Subject = {
  name: string;
  review(work: WorkUpdate): string;
  revise(work: WorkUpdate, feedback: string[]): string;
};

export const ticketDoc = (ticket: string): Subject => ({
  name: "ticket doc",
  review: (doc) => md`
    Review ${doc.docPath} for ${ticket}.
    Return ready only when its claims are verified and someone can implement it without more research.
  `,
  revise: (doc, feedback) => md`
    ${list(`Revise ${doc.docPath} from this review:`, feedback)}
    Recheck the affected claims before returning.
  `,
});

/** `resolved` is feedback the reviewer must confirm the implementer resolved. */
export const implementation = (ticket: string, resolved: string[] = []): Subject => ({
  name: "implementation",
  review: (work) => md`
    Review the implementation of ${ticket} described by ${work.docPath}.
    Its author says: ${work.summary}
    ${list("Decisions it recorded:", work.decisions)}
    Inspect the actual changes and return ready only when they are correct and complete.
    ${list("Verify that this additional feedback was resolved:", resolved)}
  `,
  revise: (work, feedback) => md`
    ${list(`Apply this review feedback to your implementation of ${ticket}:`, feedback)}
    Update ${work.docPath} with any resulting decisions or deviations.
  `,
});

/** Returns the loop where the primary reviewer reviews and the author revises, until it approves. */
export function reviewLoop(workflow: WorkflowContext, reviewer: Session, maxRevisions = 3) {
  return async (author: Session, initial: WorkUpdate, subject: Subject): Promise<Reviewed> => {
    let work = initial;
    for (let revisions = 0; ; revisions += 1) {
      const verdict = await reviewer.ask(VERDICT, {
        label: `Review ${subject.name}`,
        prompt: subject.review(work),
      });
      if (verdict.kind === "ready") return { summary: verdict.summary, work };
      if (verdict.kind === "inconclusive") return reviewer.stop(verdict.reason);
      if (revisions >= maxRevisions) {
        return workflow.stop(`${subject.name}: still not approved after ${revisions} revisions`);
      }
      work = await workOn(author, work.docPath, {
        label: `Revise ${subject.name}`,
        prompt: subject.revise(work, verdict.feedback),
      });
    }
  };
}

/** An author's turn on the ticket doc; an answer naming another doc stops the run. */
export async function workOn(
  author: Session,
  doc: string,
  turn: { label: string; prompt: string },
): Promise<WorkUpdate> {
  const work = await author.ask(WORK, turn);
  return work.docPath === doc ? work : author.stop("updated a different ticket document");
}

/** Each additional reviewer on its own, all at once; the first to stop the run stops the rest. */
export function additionalReviews(
  workflow: WorkflowContext,
  { ticket, additionalReviewers = [] }: FeatureArgs,
  openReviewer: (extra: AdditionalReviewer) => Promise<Session>,
  work: WorkUpdate,
): Promise<AdditionalReview[]> {
  return workflow.parallel(
    additionalReviewers,
    async (extra): Promise<AdditionalReview> => {
      const reviewer = await openReviewer(extra);
      const verdict = await reviewer.ask(VERDICT, {
        label: `Review implementation: ${extra.name}`,
        prompt: implementation(ticket).review(work),
      });
      if (verdict.kind === "inconclusive") return reviewer.stop(verdict.reason);
      return { reviewer: extra.name, ...verdict };
    },
    { label: "Additional implementation reviews", concurrency: 4 },
  );
}

/** What the additional reviewers asked for, each line under its reviewer's name. */
export function requestedChanges(reviews: AdditionalReview[]): string[] {
  return reviews.flatMap((review) =>
    review.kind === "changes-requested"
      ? review.feedback.map((line) => `${review.reviewer}: ${line}`)
      : [],
  );
}

export function tally(reviews: AdditionalReview[]): string {
  if (reviews.length === 0) return "no additional reviewers";
  const asking = reviews.filter((review) => review.kind === "changes-requested").length;
  return `${asking} of ${reviews.length} asked for changes`;
}
