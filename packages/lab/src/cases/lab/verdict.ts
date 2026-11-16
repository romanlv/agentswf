import type { Errored, Outcome, Verdict } from "../format/records";

/** What one trial came to, before the order below picks its outcome. */
export type TrialFacts = {
  leaked: boolean;
  errored?: Pick<Errored, "by">;
  /** The workflow erred: its body failed or timed out, or `observe` returned an `error`. */
  workflowErred: boolean;
  /** Its body called `wf.stop` before any `until`. */
  stopped: boolean;
  /** Each grader that gave a verdict; empty when none did. */
  verdicts: readonly Verdict[];
  /** Some grader gave numbers. */
  numbers: boolean;
  /** No grader applies, or the key is a draft. */
  notGraded: boolean;
};

/** When several apply, the first in this order counts. */
export function outcomeOf(trial: TrialFacts): Outcome {
  if (trial.leaked) return "leaked";
  if (trial.errored) return "errored";
  if (trial.stopped) return "stopped";
  if (trial.workflowErred || trial.verdicts.includes("failed")) return "failed";
  if (trial.notGraded) return "not graded";
  if (trial.verdicts.length === 0) return trial.numbers ? "graded by numbers" : "not graded";
  if (trial.verdicts.includes("undecided")) return "undecided";
  return "passed";
}

export type CaseVerdict = "passed" | "failed" | "flaky" | "unclear";

/** `"all"` or `"{n}/{d}"`: the share of trials that must pass. */
export function needOf(pass: string, trials: number): number {
  if (pass === "all") return trials;
  const [n, d] = pass.split("/").map(Number) as [number, number];
  return Math.min(trials, Math.ceil((n / d) * trials - 1e-9));
}

export type CaseTally = {
  verdict?: CaseVerdict;
  /** Set when the case has no verdict: all its trials not graded, or graded by numbers only. */
  none?: "not graded" | "graded by numbers";
  passed: number;
  failed: number;
  trials: number;
  need: number;
  /** Why an unclear case is unclear, or why a passing bar was rounded up. */
  note?: string;
};

/**
 * A case's verdict from its trials' outcomes, with `trials` the count asked for. A stopped trial is
 * a failed one: the workflow erred.
 */
export function caseVerdict(outcomes: readonly Outcome[], trials: number, pass: string): CaseTally {
  const need = needOf(pass, trials);
  const passed = outcomes.filter((o) => o === "passed").length;
  const failed = outcomes.filter((o) => o === "failed" || o === "stopped").length;
  const tally = { passed, failed, trials, need };
  if (outcomes.length > 0 && outcomes.every((o) => o === "not graded")) {
    return { ...tally, none: "not graded" };
  }
  if (
    outcomes.length > 0 &&
    outcomes.every((o) => o === "graded by numbers" || o === "not graded")
  ) {
    return { ...tally, none: "graded by numbers" };
  }
  const rounded =
    pass !== "all" && need === trials && trials > 0 && needOf(pass, 3 * trials) < 3 * trials
      ? `the ${pass} bar at ${trials} trial${trials === 1 ? "" : "s"} asks every one`
      : undefined;
  const withNote = (verdict: CaseVerdict, note?: string): CaseTally => ({
    ...tally,
    verdict,
    ...((note ?? rounded) ? { note: note ?? rounded } : {}),
  });
  if (passed >= need) return withNote("passed");
  if (failed > trials / 2) return withNote("failed");
  if (passed >= 1 && failed >= 1) return withNote("flaky");
  const counts = (["errored", "undecided", "leaked"] as const)
    .map((o) => [o, outcomes.filter((x) => x === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([o, n]) => `${n} ${o}`);
  const missing = trials - outcomes.length;
  if (missing > 0) counts.push(`${missing} not run`);
  return withNote("unclear", counts.length > 0 ? counts.join(", ") : undefined);
}

export type ExitInputs = {
  cases: readonly {
    tally: CaseTally;
    knownFailing: boolean;
    /** A trial of it errored by the dataset or by grading, or leaked. */
    brokenTrial: boolean;
    /** A trial of it errored by the lab, or was cancelled. */
    labTrial?: boolean;
  }[];
  partial: boolean;
};

export type ExitCode = 0 | 1 | 3 | 4 | 5;

/**
 * The exit code of `run`, `report` and `score`, from your checkout's column alone. A trial the lab
 * broke says nothing of the workflow, so it outranks every verdict, as the lab breaking mid-run
 * does.
 */
export function exitCodeOf({ cases, partial }: ExitInputs): ExitCode {
  if (cases.some((c) => c.labTrial)) return 4;
  const counted = cases.filter((c) => !c.knownFailing);
  if (counted.some((c) => c.tally.verdict === "failed")) return 1;
  if (cases.some((c) => c.brokenTrial)) return 5;
  const graded = cases.some((c) => c.tally.verdict || c.tally.none === "graded by numbers");
  if (
    partial ||
    !graded ||
    counted.some((c) => c.tally.verdict === "flaky" || c.tally.verdict === "unclear")
  ) {
    return 3;
  }
  return 0;
}

/** Whether a trial errored so a CI must not pass it: by the dataset or by grading, or leaked. */
export function isBroken(outcome: Outcome, errored?: Pick<Errored, "by">): boolean {
  return (
    outcome === "leaked" ||
    (outcome === "errored" && (errored?.by === "dataset" || errored?.by === "grading"))
  );
}
