// How two variants' per-case numbers become a verdict. Knows nothing of reviews, so a comparison
// serves any kind of case: the scorer names the metrics, and this reads only their numbers.

/** One number a scorer gives each trial. */
export type MetricSpec = {
  name: string;
  direction: "higher" | "lower";
  /** What a trial whose variant failed scores, or `missing` to leave it out. */
  onVariantFailure: number | "missing";
};

/**
 * One trial's numbers. `variant-failed` is a result, scored by each metric's `onVariantFailure`;
 * `missing` (never run, or its scorer failed) is left out.
 */
export type CaseScore = {
  case: string;
  trial: number;
  outcome: "scored" | "variant-failed" | "missing";
  /** `null` where the metric doesn't apply, such as recall on a case with no issue of a kind. */
  metrics: Readonly<Record<string, number | null>>;
};

/** A metric as the comparison saw it: challenger minus baseline, over the cases both have. */
export type ComparedMetric = {
  name: string;
  /** Why the rule looked at it. */
  role: "primary" | "guard" | "tiebreak" | "reported";
  cases: number;
  baseline: number | null;
  challenger: number | null;
  difference: number | null;
  /** The two-sided interval on the difference, at the comparison's confidence; absent below 5 cases. */
  interval?: [number, number];
  /** Cases where the challenger did better, the same, worse, by the metric's direction. */
  won: number;
  tied: number;
  lost: number;
};

export type Verdict = {
  verdict: "better" | "worse" | "tie" | "undecided";
  /** Whether a run should spend no more on this pair. */
  stop: boolean;
  /** One sentence a person reads first. */
  reason: string;
  metrics: ComparedMetric[];
};

export type ComparisonInput = {
  baseline: readonly CaseScore[];
  challenger: readonly CaseScore[];
  metrics: readonly MetricSpec[];
  /** How many cases the selection holds, a count, so a rule can tell its last look. */
  selected: number;
};

/** A comparison file's default export. */
export type Comparison = {
  kind: typeof COMPARISON_KIND;
  /** In semver, as a variant's: the report names it, so a verdict says which rule gave it. */
  version: string;
  compare(input: ComparisonInput): Verdict;
};

export const COMPARISON_KIND = "awf.comparison/1";

/** A comparison of your own: `compare` gets both variants' trials and returns the verdict. */
export function defineComparison(options: {
  version?: string;
  compare(input: ComparisonInput): Verdict;
}): Comparison {
  return { kind: COMPARISON_KIND, version: options.version ?? "1.0.0", compare: options.compare };
}
