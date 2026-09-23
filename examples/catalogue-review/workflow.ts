import {
  isAnswered,
  type RuntimeSelection,
  type TurnUsage,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@wf/contract/workflow";
import { catalogueLensPrompt, verificationPrompt } from "./prompts";
import {
  FINDINGS_SCHEMA,
  type RawFinding,
  VERDICT_SCHEMA,
  type Verdict,
} from "./schema";

type Lens = { id: string; page: string };

type Finding = RawFinding & { lens: string; page: string };

type Verification =
  | { kind: "not-checked" }
  | { kind: "confirmed"; reason: string }
  | { kind: "refuted"; reason: string };

type ReviewedFinding = Finding & {
  verification: Verification;
  attributionFailure?: string;
};

type CatalogueArgs = {
  project: string;
  iid: number;
  range: string;
  lenses: Lens[];
  maxVerifyPerLens?: number;
  runtime: RuntimeSelection;
};

type Failure = {
  stage: "lens" | "verify";
  subject: string;
  reason: string;
};

type CatalogueResult = {
  findings: ReviewedFinding[];
  failures: Failure[];
  usage: TurnUsage[];
};

type LensResult =
  | { kind: "completed"; lens: Lens; findings: RawFinding[] }
  | { kind: "failed"; lens: Lens; reason: string };

export const catalogueReview: WorkflowDefinition<CatalogueArgs, CatalogueResult> = {
  meta: {
    name: "catalogue-review",
    description: "Review a diff through independent catalogue lenses and verify their findings.",
    whenToUse: "Use for read-only reviews where each lens must inspect the diff independently.",
  },

  async run(workflow, args) {
    if (new Set(args.lenses.map((lens) => lens.id)).size !== args.lenses.length) {
      throw new Error("catalogue-review: lens ids must be unique");
    }

    const verificationLimit = Math.max(0, Math.floor(args.maxVerifyPerLens ?? 3));
    const lensResults = await workflow.parallel(
      args.lenses,
      (lens) => runLens(workflow, args, lens),
      { label: "Catalogue lenses", concurrency: 6 },
    );
    const lensFailures = lensResults.flatMap((result) =>
      result.kind === "failed"
        ? [{ stage: "lens" as const, subject: result.lens.id, reason: result.reason }]
        : [],
    );
    const { candidates, unchecked } = selectVerificationCandidates(
      workflow,
      lensResults,
      verificationLimit,
    );
    const verified = await verifyFindings(workflow, args, candidates);

    return {
      findings: [...verified.findings, ...unchecked],
      failures: [...lensFailures, ...verified.failures],
      usage: workflow.usage(),
    };
  },
};

function selectVerificationCandidates(
  workflow: WorkflowContext,
  results: LensResult[],
  verificationLimit: number,
): { candidates: Finding[]; unchecked: ReviewedFinding[] } {
  const candidates: Finding[] = [];
  const unchecked: ReviewedFinding[] = [];

  for (const result of results) {
    if (result.kind === "failed") continue;
    const findings = result.findings.map((finding) => normalizeFinding(result.lens, finding));
    const actionable = findings.filter((finding) => finding.severity !== "observation");
    candidates.push(...actionable.slice(0, verificationLimit));
    unchecked.push(
      ...findings.filter((finding) => finding.severity === "observation").map(notVerified),
      ...actionable.slice(verificationLimit).map(notVerified),
    );
    if (actionable.length > verificationLimit) {
      workflow.log(
        `${result.lens.id}: ${actionable.length - verificationLimit} findings not verified`,
      );
    }
  }
  return { candidates, unchecked };
}

async function runLens(
  workflow: WorkflowContext,
  args: CatalogueArgs,
  lens: Lens,
): Promise<LensResult> {
  try {
    const reviewer = await workflow.agents.open({
      key: `lens:${lens.id}`,
      instructions: `Apply only the ${lens.id} lens from ${lens.page}.`,
      runtime: args.runtime,
      labels: { lens: lens.id },
    });
    const { outcome } = await reviewer.run({
      prompt: catalogueLensPrompt(args.project, args.iid, args.range, lens.page),
      schema: FINDINGS_SCHEMA,
    });

    return isAnswered(outcome)
      ? {
          kind: "completed",
          lens,
          findings: outcome.value.findings,
        }
      : {
          kind: "failed",
          lens,
          reason: outcome.reason,
        };
  } catch (error) {
    return {
      kind: "failed",
      lens,
      reason: message(error),
    };
  }
}

async function verifyFindings(
  workflow: WorkflowContext,
  args: CatalogueArgs,
  findings: Finding[],
): Promise<{ findings: ReviewedFinding[]; failures: Failure[] }> {
  const results = await workflow.parallel(
    findings,
    async (finding, index) => {
      try {
        const verifier = await workflow.agents.open({
          key: `verifier:${index}`,
          instructions: "Try to refute this finding against the diff and surrounding code.",
          runtime: args.runtime,
          labels: { verifier: index },
        });
        const { outcome } = await verifier.run({
          prompt: verificationPrompt(args.range, finding),
          schema: VERDICT_SCHEMA,
        });

        return isAnswered(outcome)
          ? { finding: applyVerdict(finding, outcome.value) }
          : { finding: notVerified(finding), failure: outcome.reason };
      } catch (error) {
        return { finding: notVerified(finding), failure: message(error) };
      }
    },
    { label: "Verify findings", concurrency: 4 },
  );

  return {
    findings: results.map((result) => result.finding),
    failures: results.flatMap((result) =>
      result.failure
        ? [{ stage: "verify", subject: findingSubject(result.finding), reason: result.failure }]
        : [],
    ),
  };
}

function normalizeFinding(lens: Lens, finding: RawFinding): Finding {
  return {
    ...finding,
    lens: lens.id,
    page: lens.page,
    source: finding.source === "catalogue" && !finding.rule ? "general" : finding.source,
  };
}

function applyVerdict(finding: Finding, verdict: Verdict): ReviewedFinding {
  const invalidAttribution = finding.source === "catalogue" && verdict.attribution !== "valid";
  if (invalidAttribution) {
    const { rule: _, ...general } = finding;
    return {
      ...general,
      source: "general",
      verification: verificationFrom(verdict),
      attributionFailure: verdict.reason,
    };
  }
  return {
    ...finding,
    verification: verificationFrom(verdict),
  };
}

function notVerified(finding: Finding): ReviewedFinding {
  return { ...finding, verification: { kind: "not-checked" } };
}

function verificationFrom(verdict: Verdict): Verification {
  return {
    kind: verdict.refuted ? "refuted" : "confirmed",
    reason: verdict.reason,
  };
}

function findingSubject(finding: Finding): string {
  return `${finding.lens}:${finding.file}:${finding.line ?? 0}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
