import type { WorkUpdate } from "./schema";

export type ReviewSubject =
  | { kind: "ticket-doc"; ticket: string }
  | { kind: "implementation"; focus?: string[] };

export function reviewPrompt(subject: ReviewSubject, work: WorkUpdate): string {
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
        "Apply this review feedback:",
        ...feedback.map((item) => `- ${item}`),
        `Update ${work.docPath} with any resulting decisions or deviations.`,
      ].join("\n");
}
