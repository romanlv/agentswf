import type { OutputRecord } from "@wf/contract/records";
import { defineExecutableWorkflow } from "@wf/contract/workflow";
import { JUDGEMENT_FORMAT, type Judgement, type RunSummary } from "./scoring";
import { defineReviewJudge, defineReviewVariant } from "./variant";

type Finding = { file: string; line?: number; claim: string; refuted: boolean };

const review = defineExecutableWorkflow<{ range: string }, { findings: Finding[] }>({
  definition: {
    meta: { name: "review", description: "A review workflow with a shape of its own." },
    run: async () => ({ findings: [] }),
  },
  prepare: () => ({ range: "HEAD" }),
});

const judge = defineExecutableWorkflow<{ fixture: string }, Judgement>({
  definition: {
    meta: { name: "judge", description: "A judge." },
    run: async () => ({ format: JUDGEMENT_FORMAT, labels: [], missed: "" }),
  },
  prepare: () => ({ fixture: "f" }),
});

const workflow = new URL("./review.ts", import.meta.url);

defineReviewVariant<typeof review>({
  workflow,
  argv: ["--range", "{base}...HEAD"],
  timeout: "30m",
  read: (result) =>
    result.findings
      .filter((f) => !f.refuted)
      .map((f) => ({ path: f.file, line: f.line, text: f.claim })),
});

defineReviewVariant<typeof review>({
  workflow,
  argv: [],
  timeout: "30m",
  // @ts-expect-error `issues` is not in the workflow's result: its shape changed under the variant.
  read: (result) => result.issues.map((f: Finding) => ({ text: f.claim })),
});

defineReviewVariant<typeof review>({
  workflow,
  argv: [],
  timeout: "30m",
  // @ts-expect-error a finding needs `text`; `claim` is the workflow's word, not ours.
  read: (result) => result.findings.map((f) => ({ claim: f.claim })),
});

defineReviewJudge<typeof judge>({ workflow, argv: [], timeout: "20m" });

// @ts-expect-error a review workflow does not return a Judgement.
defineReviewJudge<typeof review>({ workflow, argv: [], timeout: "20m" });

// A run's outcome, as a score keeps it, is exactly the one `output.json` records.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameOutcomes: Same<RunSummary["outcome"], OutputRecord["outcome"]> = true;
void sameOutcomes;
