import type { CaseScore } from "../../compare";
import { resolution, varianceOf } from "../../compare/resolution";
import type { AnswerKey } from "../format/format";
import { CHECK_FORMAT, type CheckDocument } from "../format/output";
import { namedMetrics, REVIEW_METRICS } from "../metrics/named";
import { formatAddress } from "./address";
import { type CaseState, currentTrials, passingScore, type Stored } from "./plan";
import { caseMetrics } from "./report";
import { keyOf } from "./version";

const PRIMARY = REVIEW_METRICS.find((m) => m.name === "recall.weighted")!;
/** A mean at this share of the most a metric can be leaves no room for a change to show. */
const CEILING = 0.95;

/** One case as `check` reads it for a variant: what the store holds, and the key as it is now. */
export type CheckRow = { state: CaseState; key: AnswerKey };

/** Each current trial of a case, numbered, with the scorer's passing score when it has one. */
function scoredTrials(row: CheckRow, scorerKey: string) {
  return currentTrials(row.state).map((stored, i) => ({
    n: i + 1,
    stored,
    score: passingScore(stored, scorerKey, row.key.revision),
  }));
}

function caseScore(row: CheckRow, n: number, stored: Stored, scorerKey: string): CaseScore | null {
  const score = passingScore(stored, scorerKey, row.key.revision);
  if (score?.result.status !== "scored") return null;
  return {
    case: row.state.case,
    trial: n,
    outcome: stored.trial.failure ? "variant-failed" : "scored",
    metrics: namedMetrics(caseMetrics(stored.trial, score, row.key), stored.trial.run),
  };
}

/**
 * Whether a variant's cases can tell a change from noise, from stored records: headroom on
 * weighted recall, its variance between cases and between trials of one, the smallest difference
 * the planned cases and trials resolve, failures by kind, and suspect cases, which score 0 on every
 * trial of every variant (`everyone`, each variant's rows on the same cases).
 */
export function buildCheck(options: {
  dataset: string;
  variant: { name: string; version: string };
  scorer: { name: string; version: string; key: string };
  /** Trials a case, as asked: what the resolution is for. */
  trials: number;
  /** The dataset's size, for the resolution of the whole. */
  datasetCases: number;
  rows: readonly CheckRow[];
  everyone: readonly (readonly CheckRow[])[];
  rescore?: CheckDocument["rescore"];
}): CheckDocument {
  const { rows, scorer, trials } = options;
  const scores = rows.flatMap((row) =>
    scoredTrials(row, scorer.key).flatMap(({ n, stored }) => {
      const score = caseScore(row, n, stored, scorer.key);
      return score ? [score] : [];
    }),
  );
  const variance = varianceOf(scores, PRIMARY);
  const at = (row: CheckRow, n: number) => formatAddress({ case: row.state.case, trial: n });
  const failures: CheckDocument["failures"] = {
    variant: [],
    neverStarted: [],
    otherSandbox: [],
    scoreFailed: [],
    notScored: [],
  };
  for (const row of rows) {
    const onDigest = row.state.stored.filter((s) => s.trial.case.digest === row.state.digest);
    const current = currentTrials(row.state);
    if (onDigest.some((s) => s.trial.run.id === undefined)) {
      failures.neverStarted.push(row.state.case);
    }
    if (onDigest.some((s) => s.trial.run.id !== undefined && !current.includes(s))) {
      failures.otherSandbox.push(row.state.case);
    }
    for (const { n, stored, score } of scoredTrials(row, scorer.key)) {
      if (stored.trial.failure) failures.variant.push(at(row, n));
      if (score) continue;
      const tried = stored.scores.some(
        (s) => keyOf(s.scorer) === scorer.key && s.key.revision === row.key.revision,
      );
      (tried ? failures.scoreFailed : failures.notScored).push(at(row, n));
    }
  }
  const suspect = rows.flatMap((row, index) => {
    const values = options.everyone.flatMap((theirs) => {
      const same = theirs[index];
      if (!same) return [];
      return scoredTrials(same, scorer.key).flatMap(({ n, stored }) => {
        const score = caseScore(same, n, stored, scorer.key);
        const value = score?.outcome === "scored" ? score.metrics[PRIMARY.name] : undefined;
        return value === undefined || value === null ? [] : [value];
      });
    });
    return values.length >= 2 && values.every((v) => v === 0) ? [row.state.case] : [];
  });
  return {
    format: CHECK_FORMAT,
    dataset: options.dataset,
    variant: options.variant,
    scorer: { name: scorer.name, version: scorer.version },
    metric: PRIMARY.name,
    headroom: {
      mean: variance.mean,
      max: 1,
      warning: variance.mean !== null && variance.mean >= CEILING,
    },
    variance: {
      cases: variance.cases,
      trials: variance.trials,
      between: variance.between,
      within: variance.within,
    },
    resolution: {
      cases: rows.length,
      trials,
      range: resolution(variance, rows.length, trials),
      dataset: {
        cases: options.datasetCases,
        range: resolution(variance, options.datasetCases, trials),
      },
    },
    failures,
    suspect,
    ...(options.rescore ? { rescore: options.rescore } : {}),
  };
}

const two = (x: number) => x.toFixed(2);
const sd = (v: number | null) => (v === null ? "–" : two(Math.sqrt(v)));
const range = (r: [number, number] | null) => (r ? `~${two(r[0])}–${two(r[1])}` : null);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The headroom and resolution lines, which `run --baseline` also prints before it spends. */
export function checkLines(check: CheckDocument): string[] {
  const { headroom, variance, resolution: r } = check;
  const lines = [
    headroom.mean === null
      ? "headroom    no scored trial yet"
      : `headroom    ${check.metric} ${two(headroom.mean)} of ${headroom.max}${headroom.warning ? ": at the ceiling, so no change could show" : ": room to improve"}`,
  ];
  if (r.cases < 2) {
    lines.push("resolution  unknown: a comparison needs two cases at least");
  } else if (variance.within === null) {
    lines.push(
      `resolution  unknown: no case has two scored trials, so trial noise can't be told from case differences; run --trials 2`,
    );
  } else {
    lines.push(
      `variance    sd ${sd(variance.between)} between cases, ${sd(variance.within)} between trials of one, over ${plural(variance.cases, "case")}`,
    );
    const here = range(r.range);
    const whole = range(r.dataset.range);
    lines.push(
      `resolution  ${plural(r.cases, "case")} × ${plural(r.trials, "trial")}: differences under ${here ?? "?"} are noise${r.dataset.cases !== r.cases ? `; all ${r.dataset.cases} resolve ${whole ?? "?"}` : ""}`,
    );
  }
  return lines;
}

/** The whole check as a person reads it. */
export function renderCheck(check: CheckDocument): string {
  const lines = [
    `${check.variant.name} ${check.variant.version}, scorer ${check.scorer.name} ${check.scorer.version}, dataset ${check.dataset}`,
    ...checkLines(check),
  ];
  if (check.rescore) {
    const { trials, findings, same, kappa, listPrice } = check.rescore;
    lines.push(
      `scorer      re-scored ${plural(trials, "trial")}: the same label on ${same} of ${plural(findings, "finding")}${kappa === null ? "" : ` (κ ${two(kappa)})`}, $${two(listPrice)} at list prices; no score kept, only its run directories`,
    );
    for (const d of check.rescore.differ)
      lines.push(`              ${d.id}: ${d.labels.join(", then ")}`);
  }
  const f = check.failures;
  const kinds = [
    [f.variant, "variant failed (a result)"],
    [f.neverStarted, "with a run that never started, not counted"],
    [f.otherSandbox, "with a trial in another sandbox, not counted"],
    [f.scoreFailed, "score failed (run again)"],
    [f.notScored, "not scored"],
  ] as const;
  const found = kinds.filter(([ids]) => ids.length > 0);
  lines.push(
    found.length === 0
      ? "failures    none"
      : `failures    ${found.map(([ids, what]) => `${ids.length} ${what}: ${ids.join(", ")}`).join("; ")}`,
  );
  lines.push(
    check.suspect.length === 0
      ? "suspect     none"
      : `suspect     ${plural(check.suspect.length, "case")} score 0 on every trial of every variant: ${check.suspect.join(", ")}; read them before counting`,
  );
  return lines.join("\n");
}
