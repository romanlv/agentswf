import type { OutputRecord } from "@agentswf/contract/records";
import { defineExecutableWorkflow } from "@agentswf/contract/workflow";
import { type RunSummary, SCORER_RESULT_FORMAT, type ScorerResult } from "./scoring";
import { defineReviewScorer, defineReviewVariant } from "./variant";

type Finding = { file: string; line?: number; claim: string; refuted: boolean };

const review = defineExecutableWorkflow<{ range: string }, { findings: Finding[] }>({
  definition: {
    meta: { name: "review", description: "A review workflow with a shape of its own." },
    run: async () => ({ findings: [] }),
  },
  prepare: () => ({ range: "HEAD" }),
});

const judge = defineExecutableWorkflow<{ fixture: string }, ScorerResult>({
  definition: {
    meta: { name: "judge", description: "A judge." },
    run: async () => ({ format: SCORER_RESULT_FORMAT, labels: [], missed: "" }),
  },
  prepare: () => ({ fixture: "f" }),
});

// The workflow's type comes from the value: no type argument to forget.
defineReviewVariant({
  workflow: review,
  argv: ["--range", "{base}...HEAD"],
  timeout: "30m",
  read: (result) =>
    result.findings
      .filter((f) => !f.refuted)
      .map((f) => ({ path: f.file, line: f.line, text: f.claim })),
});

defineReviewVariant({
  workflow: review,
  argv: [],
  timeout: "30m",
  // @ts-expect-error `issues` is not in the workflow's result: its shape changed under the variant.
  read: (result) => result.issues.map((f: Finding) => ({ text: f.claim })),
});

defineReviewVariant({
  workflow: review,
  argv: [],
  timeout: "30m",
  // @ts-expect-error a finding needs `text`; `claim` is the workflow's word, not ours.
  read: (result) => result.findings.map((f) => ({ claim: f.claim })),
});

defineReviewVariant({
  // @ts-expect-error a path is not a workflow: the variant imports the value.
  workflow: "./review.ts",
  argv: [],
  timeout: "30m",
  read: () => [],
});

// The variant is its workflow, so `awf run` runs the variant file.
const variant: typeof review = defineReviewVariant({
  workflow: review,
  argv: [],
  timeout: "30m",
  read: () => [],
});
void variant;

defineReviewScorer({ workflow: judge, argv: [], timeout: "20m" });

// @ts-expect-error a review workflow does not return a ScorerResult.
defineReviewScorer({ workflow: review, argv: [], timeout: "20m" });

// A run's outcome, as a score keeps it, is the one `output.json` records.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameOutcomes: Same<RunSummary["outcome"], OutputRecord["outcome"]> = true;
void sameOutcomes;
