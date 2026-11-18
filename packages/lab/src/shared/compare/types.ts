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
 * `missing` (never run, or its scorer failed) is left out. A comparison should treat any outcome
 * it doesn't know as `missing`: failures may later be told apart by kind.
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
  /** Cases both variants have a value for; each case's value is the mean of its trials. */
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

/**
 * What a comparison says about a challenger. `stop` says whether a run should spend more on it:
 * `undecided` with `stop` means the plan ran out without an answer, as when too few cases are won,
 * or the rule stopped early because more cases could not give an answer worth having.
 */
export type Verdict = {
  verdict: "better" | "worse" | "tie" | "undecided";
  /** Whether a run should spend no more on this pair. */
  stop: boolean;
  /** One sentence a person reads first. */
  reason: string;
  metrics: ComparedMetric[];
};

export type ComparisonInput = {
  /** Every trial so far, per variant, of the cases planned. */
  baseline: readonly CaseScore[];
  challenger: readonly CaseScore[];
  metrics: readonly MetricSpec[];
  /**
   * How many cases the plan runs in all, a count: the dataset's size, whose seeded order the
   * cases come in. A rule's looks count towards it, and its last look is when all have run.
   */
  planned: number;
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
  /** In semver; bump it whenever the rule changes, as the report names it beside each verdict. */
  version: string;
  compare(input: ComparisonInput): Verdict;
}): Comparison {
  return { kind: COMPARISON_KIND, version: options.version, compare: options.compare };
}
