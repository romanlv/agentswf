import type { WorkUpdate } from "./schema";

/** What is reviewed. Each names its ticket: on a continue, the agent asked starts fresh. */
export type ReviewSubject =
  | { kind: "ticket-doc"; ticket: string }
  | { kind: "implementation"; ticket: string; focus?: string[] };

export function reviewPrompt(subject: ReviewSubject, work: WorkUpdate): string {
  if (subject.kind === "ticket-doc") {
    return [
      `Review ${work.docPath} for ${subject.ticket}.`,
      "Return ready only when its claims are verified and someone can implement it without more research.",
    ].join("\n");
  }

  return [
    `Review the implementation of ${subject.ticket} described by ${work.docPath}.`,
    `Its author says: ${work.summary}`,
    ...(work.decisions.length > 0
      ? ["Decisions it recorded:", ...work.decisions.map((item) => `- ${item}`)]
      : []),
    "Inspect the actual changes and return ready only when they are correct and complete.",
    ...(subject.focus && subject.focus.length > 0
      ? [
          "Verify that this additional feedback was resolved:",
          ...subject.focus.map((item) => `- ${item}`),
        ]
      : []),
  ].join("\n");
}

export function revisionPrompt(
  subject: ReviewSubject,
  work: WorkUpdate,
  feedback: string[],
): string {
  return subject.kind === "ticket-doc"
    ? [
        `Revise ${work.docPath} from this review:`,
        ...feedback.map((item) => `- ${item}`),
        "Recheck the affected claims before returning.",
      ].join("\n")
    : [
        `Apply this review feedback to your implementation of ${subject.ticket}:`,
        ...feedback.map((item) => `- ${item}`),
        `Update ${work.docPath} with any resulting decisions or deviations.`,
      ].join("\n");
}
