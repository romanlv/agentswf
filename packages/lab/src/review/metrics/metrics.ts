import {
  type AnswerKey,
  CATEGORIES,
  type Category,
  type KnownIssue,
  SEVERITIES,
  type Severity,
} from "../format/format";
import type {
  FindingLabel,
  FindingsRecord,
  Label,
  ReviewFinding,
  RunSummary,
  ScoreRecord,
} from "../format/scoring";
import { LABELS } from "../format/scoring";

/** Where a known issue came from: a review comment, a later fix nobody commented on, or a run. */
export type SourceKind = "comment" | "commit" | "run";

/** One fixture's findings, labelled against its key. */
export type Judged = {
  fixture: string;
  findings: readonly ReviewFinding[];
  labels: readonly FindingLabel[];
  key: AnswerKey;
};

/**
 * Only these categories count: a true finding outside them is neither rewarded nor penalised. A
 * false one counts whatever it was about, even a symptom of an issue outside them.
 */
export type Filter = { categories?: readonly Category[] };

export type Tally = { total: number; hit: number };
export type Missed = { fixture: string; issue: string; mechanism: string };

/**
 * What the metrics are computed from: counts, so that fixtures are summed before dividing. Issues
 * the MR caused are counted by severity, category and source; issues it only sat beside
 * (`scope: "context"`) are counted apart.
 */
export type Counts = {
  fixtures: number;
  bySeverity: Record<Severity, Tally>;
  byCategory: Record<Category, Tally>;
  bySource: Record<SourceKind, Tally>;
  context: Tally;
  /** Findings counted, repeats included. */
  findings: number;
  labels: Record<Label, number>;
  /** Distinct findings about nits only: a hit on a nit, or a new nit. */
  nits: number;
  /** Words in every finding's text, filter or not: what a person had to read. */
  words: number;
  /** Every `must-fix` the MR caused that no finding hit. */
  missed: Missed[];
};

const WEIGHTS: Record<Exclude<Severity, "nit">, number> = {
  "must-fix": 3,
  "should-fix": 2,
  "could-fix": 1,
};

const tallies = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, { total: 0, hit: 0 }])) as Record<K, Tally>;

function emptyCounts(): Counts {
  return {
    fixtures: 0,
    bySeverity: tallies(SEVERITIES),
    byCategory: tallies(CATEGORIES),
    bySource: tallies(["comment", "commit", "run"] as const),
    context: { total: 0, hit: 0 },
    findings: 0,
    labels: Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>,
    nits: 0,
    words: 0,
    missed: [],
  };
}

function sourceKinds(issue: KnownIssue): Set<SourceKind> {
  return new Set(
    issue.sources.map(
      (source): SourceKind =>
        "discussion" in source ? "comment" : "commit" in source ? "commit" : "run",
    ),
  );
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** One fixture's counts. The labels must have passed `checkScorerResult` against these findings and key. */
export function count(judged: Judged, filter: Filter = {}): Counts {
  if (filter.categories?.length === 0) throw new Error("a category filter names at least one");
  const counts = emptyCounts();
  counts.fixtures = 1;
  const counted = (category: Category) =>
    !filter.categories || filter.categories.includes(category);
  const issues = new Map(judged.key.issues.map((issue) => [issue.id, issue]));
  const hit = new Set(judged.labels.flatMap((l) => (l.label === "hit" ? [l.issue] : [])));

  for (const issue of judged.key.issues) {
    if (!counted(issue.category)) continue;
    const found = hit.has(issue.id) ? 1 : 0;
    const add = (tally: Tally) => {
      tally.total += 1;
      tally.hit += found;
    };
    if (issue.scope === "context") {
      add(counts.context);
      continue;
    }
    add(counts.bySeverity[issue.severity]);
    add(counts.byCategory[issue.category]);
    for (const kind of sourceKinds(issue)) add(counts.bySource[kind]);
    if (!found && issue.severity === "must-fix") {
      counts.missed.push({ fixture: judged.fixture, issue: issue.id, mechanism: issue.mechanism });
    }
  }

  for (const label of judged.labels) {
    const issue = label.label === "hit" ? issues.get(label.issue) : undefined;
    if (issue && !counted(issue.category)) continue;
    if (label.label === "new" && !counted(label.category)) continue;
    counts.findings += 1;
    counts.labels[label.label] += 1;
    if (issue?.severity === "nit" || (label.label === "new" && label.severity === "nit")) {
      counts.nits += 1;
    }
  }
  counts.words = judged.findings.reduce((sum, finding) => sum + wordsIn(finding.text), 0);
  return counts;
}

/** Counts across fixtures, summed before any division. */
export function sum(all: readonly Counts[]): Counts {
  const total = emptyCounts();
  const addTallies = <K extends string>(into: Record<K, Tally>, from: Record<K, Tally>) => {
    for (const key of Object.keys(from) as K[]) {
      into[key].total += from[key].total;
      into[key].hit += from[key].hit;
    }
  };
  for (const counts of all) {
    total.fixtures += counts.fixtures;
    addTallies(total.bySeverity, counts.bySeverity);
    addTallies(total.byCategory, counts.byCategory);
    addTallies(total.bySource, counts.bySource);
    total.context.total += counts.context.total;
    total.context.hit += counts.context.hit;
    total.findings += counts.findings;
    for (const label of LABELS) total.labels[label] += counts.labels[label];
    total.nits += counts.nits;
    total.words += counts.words;
    total.missed.push(...counts.missed);
  }
  return total;
}

export type Metrics = {
  fixtures: number;
  /** Hits over issues the MR caused, per severity; null where the key has none. */
  recall: Record<Severity, number | null>;
  /** The same weighted 3, 2, 1 over `must-fix`, `should-fix` and `could-fix`. */
  weightedRecall: number | null;
  /** Findings less the `duplicate` and `unsettled` ones. */
  distinct: number;
  /** `hit` and `new` over distinct findings; null with none. */
  precision: number | null;
  wrong: number | null;
  noise: number | null;
  /** Distinct findings about nits only, over distinct findings. */
  nits: number | null;
  words: number;
  missed: Missed[];
  counts: Counts;
};

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export function metrics(counts: Counts): Metrics {
  const recall = Object.fromEntries(
    SEVERITIES.map((s) => [s, ratio(counts.bySeverity[s].hit, counts.bySeverity[s].total)]),
  ) as Record<Severity, number | null>;
  let weighted = { hit: 0, total: 0 };
  for (const [severity, weight] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
    weighted = {
      hit: weighted.hit + weight * counts.bySeverity[severity].hit,
      total: weighted.total + weight * counts.bySeverity[severity].total,
    };
  }
  const { labels } = counts;
  const distinct = counts.findings - labels.duplicate - labels.unsettled;
  return {
    fixtures: counts.fixtures,
    recall,
    weightedRecall: ratio(weighted.hit, weighted.total),
    distinct,
    precision: ratio(labels.hit + labels.new, distinct),
    wrong: ratio(labels.wrong, distinct),
    noise: ratio(labels.noise, distinct),
    nits: ratio(counts.nits, distinct),
    words: counts.words,
    missed: counts.missed,
    counts,
  };
}

/**
 * Cohen's κ between two labellings of the same findings, a hit counting as agreement only on the
 * same issue. Null when they label different findings, or none. When chance agreement is total,
 * κ is 1 if they agree and 0 if not.
 */
export function agreement(a: readonly FindingLabel[], b: readonly FindingLabel[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const category = (label: FindingLabel) =>
    label.label === "hit" ? `hit:${label.issue}` : label.label;
  const left = a.map(category);
  const right = b.map(category);
  const n = left.length;
  const observed = left.filter((value, index) => value === right[index]).length / n;
  const share = (values: string[], value: string) => values.filter((v) => v === value).length / n;
  const expected = [...new Set([...left, ...right])].reduce(
    (sum, value) => sum + share(left, value) * share(right, value),
    0,
  );
  if (expected === 1) return observed === 1 ? 1 : 0;
  return (observed - expected) / (1 - expected);
}

/** What one phase took, summed over runs: time, and USD at list price where every run was priced. */
export type Spend = { runs: number; ms: number; estimate: number | null; complete: boolean };

export function spendOf(runs: readonly (RunSummary | undefined)[]): Spend {
  const present = runs.filter((run): run is RunSummary => run !== undefined);
  const priced = present.every((run) => run.estimate !== undefined);
  return {
    runs: present.length,
    ms: present.reduce((sum, run) => sum + run.ms, 0),
    estimate: priced ? present.reduce((sum, run) => sum + (run.estimate ?? 0), 0) : null,
    complete: priced && present.every((run) => run.complete),
  };
}

/** Time and spend per phase, the reviewer's and the judge's apart. */
export function phases(
  reviews: readonly FindingsRecord[],
  judgings: readonly ScoreRecord[],
): { restoreMs: number; review: Spend; judge: Spend } {
  return {
    restoreMs: reviews.reduce((sum, record) => sum + record.restoreMs, 0),
    review: spendOf(reviews.map((record) => record.run)),
    judge: spendOf(judgings.map((record) => record.run)),
  };
}
