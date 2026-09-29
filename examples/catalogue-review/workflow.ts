import {
  defineExecutableWorkflow,
  type ExecutableWorkflow,
  isAnswered,
  type RuntimeSelection,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowInvocation,
  type WorkflowMeta,
} from "@agentswf/contract/workflow";
import { matchesAny } from "./paths";
import { presentCatalogueResult, reportCatalogueResult } from "./present";
import { catalogueLensPrompt, type LensSource, verificationPrompt } from "./prompts";
import {
  FINDINGS_SCHEMA,
  type RawFinding,
  SEVERITY_ORDER,
  VERDICT_SCHEMA,
  type Verdict,
} from "./schema";

export type Lens = LensSource & {
  id: string;
  /** Globs over repository paths; the lens runs only when the diff touches a match. Absent: always. */
  paths?: string[];
  /** The workflow's lens runtime when absent. */
  runtime?: RuntimeSelection;
};

type Finding = RawFinding & { lens: string; page: string };

type Verification =
  | { kind: "not-checked" }
  | { kind: "confirmed"; reason: string }
  | { kind: "refuted"; reason: string };

export type ReviewedFinding = Finding & {
  verification: Verification;
  attributionFailure?: string;
};

type CatalogueArgs = {
  /** The merge request the range belongs to, when there is one. */
  request?: { project: string; iid: number };
  range: string;
  lenses: Lens[];
  /** Lenses left out because the diff touches none of their paths. */
  skipped?: string[];
  maxVerifyPerLens?: number;
  runtime: RuntimeSelection;
  /** The verifiers' runtime; the lenses' when absent. */
  verifierRuntime?: RuntimeSelection;
};

type Failure = {
  stage: "lens" | "verify";
  subject: string;
  reason: string;
};

export type CatalogueResult = {
  range: string;
  /** The ids of the lenses applied. */
  lenses: string[];
  skipped: string[];
  findings: ReviewedFinding[];
  failures: Failure[];
};

type LensResult =
  | { kind: "completed"; lens: Lens; findings: RawFinding[] }
  | { kind: "failed"; lens: Lens; reason: string };

const READ_ONLY =
  "Do not modify files. Perform the review yourself: do not delegate or launch subagents.";

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
      range: args.range,
      lenses: args.lenses.map((lens) => lens.id),
      skipped: args.skipped ?? [],
      findings: [...verified.findings, ...unchecked],
      failures: [...lensFailures, ...verified.failures],
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
    // Severity decides which findings the limit leaves unverified, not the order the lens wrote them.
    const ranked = findings.toSorted(
      (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
    );
    candidates.push(...ranked.slice(0, verificationLimit));
    unchecked.push(...ranked.slice(verificationLimit).map(notVerified));
    if (ranked.length > verificationLimit) {
      workflow.log(`${result.lens.id}: ${ranked.length - verificationLimit} findings not verified`);
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
      instructions: `Apply only the ${lens.id} lens from ${lens.page}. ${READ_ONLY}`,
      runtime: lens.runtime ?? args.runtime,
      labels: { lens: lens.id },
    });
    const { outcome } = await reviewer.run({
      prompt: catalogueLensPrompt(args.range, lens, args.request),
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
          instructions: `Try to refute this finding against the diff and surrounding code. ${READ_ONLY}`,
          runtime: args.verifierRuntime ?? args.runtime,
          labels: { verifier: index },
        });
        const { outcome } = await verifier.run({
          prompt: verificationPrompt(
            args.range,
            finding,
            args.lenses.find((lens) => lens.id === finding.lens)?.rules,
          ),
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

export type CatalogueReviewConfig = WorkflowMeta & {
  /** Every lens the workflow can apply; `--lenses` picks a subset by id. */
  lenses: Lens[];
  runtime?: RuntimeSelection;
  verifierRuntime?: RuntimeSelection;
  range?: string;
  maxVerifyPerLens?: number;
  /**
   * The repository paths the range changes. Given, a lens with `paths` runs only when one matches;
   * naming lenses with `--lenses` runs them regardless.
   */
  changedFiles?: (range: string, invocation: WorkflowInvocation) => string[];
};

/**
 * An `awf run` entry point over a fixed lens catalogue. With no arguments it reviews what the
 * current branch adds to `origin/main` through every lens; `--range` and `--lenses a,b` narrow it.
 */
export function defineCatalogueReview(
  config: CatalogueReviewConfig,
): ExecutableWorkflow<CatalogueArgs, CatalogueResult> {
  const {
    lenses,
    runtime = "claude",
    verifierRuntime,
    range = "origin/main...HEAD",
    maxVerifyPerLens,
    changedFiles,
    ...meta
  } = config;
  if (lenses.length === 0) throw new Error(`${meta.name}: the lens catalogue is empty`);
  return defineExecutableWorkflow({
    definition: { ...catalogueReview, meta },
    prepare: (invocation) => {
      const parsed = parseCatalogueArgs(meta.name, invocation, lenses, range);
      const selection =
        parsed.named || !changedFiles
          ? { lenses: parsed.lenses, skipped: [] }
          : selectLenses(parsed.lenses, changedFiles(parsed.range, invocation));
      return {
        range: parsed.range,
        ...selection,
        runtime,
        ...(verifierRuntime === undefined ? {} : { verifierRuntime }),
        ...(maxVerifyPerLens === undefined ? {} : { maxVerifyPerLens }),
      };
    },
    present: presentCatalogueResult,
    report: reportCatalogueResult,
  });
}

function parseCatalogueArgs(
  name: string,
  invocation: WorkflowInvocation,
  catalogue: Lens[],
  defaultRange: string,
): { range: string; lenses: Lens[]; named: boolean } {
  let range = defaultRange;
  let lenses = catalogue;
  let named = false;
  for (let index = 0; index < invocation.argv.length; index += 2) {
    const option = invocation.argv[index];
    const value = invocation.argv[index + 1];
    if (option !== "--range" && option !== "--lenses") {
      throw new Error(`${name}: unknown option ${option}; expected --range or --lenses`);
    }
    if (!value) throw new Error(`${name}: ${option} needs a value`);
    if (option === "--range") {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name}: invalid range`);
      range = value;
    } else {
      named = true;
      const ids = value.split(",").map((id) => id.trim());
      lenses = ids.map((id) => {
        const lens = catalogue.find((candidate) => candidate.id === id);
        if (!lens) {
          throw new Error(
            `${name}: unknown lens ${JSON.stringify(id)}; known: ${catalogue.map((known) => known.id).join(", ")}`,
          );
        }
        return lens;
      });
    }
  }
  return { range, lenses, named };
}

function selectLenses(lenses: Lens[], changed: string[]): { lenses: Lens[]; skipped: string[] } {
  const applies = (lens: Lens) =>
    !lens.paths || changed.some((path) => matchesAny(path, lens.paths!));
  return {
    lenses: lenses.filter(applies),
    skipped: lenses.filter((lens) => !applies(lens)).map((lens) => lens.id),
  };
}
