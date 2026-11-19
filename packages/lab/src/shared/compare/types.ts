// How two columns' per-case numbers become a verdict. Knows nothing of one workflow's domain: the
// caller names the metrics, and this reads only their numbers.

/** One number each trial gives. */
export type MetricSpec = {
  name: string;
  direction: "higher" | "lower";
  /** What a trial whose workflow failed scores, or `missing` to leave it out. */
  onFailure: number | "missing";
};

/**
 * One trial's numbers. `workflow-failed` is a result, scored by each metric's `onFailure`;
 * `missing` (never run, or not graded) is left out. A comparison should treat any outcome it
 * doesn't know as `missing`: failures may later be told apart by kind.
 */
export type CaseScore = {
  case: string;
  trial: number;
  outcome: "scored" | "workflow-failed" | "missing";
  /** `null` where the metric doesn't apply, such as recall on a case with nothing to find. */
  metrics: Readonly<Record<string, number | null>>;
};

/**
 * A metric as the comparison saw it: the column minus the reference, over the cases both have.
 * `baseline` and `challenger` are the reference's and the column's means; records keep the names.
 */
export type ComparedMetric = {
  name: string;
  /** Why the rule looked at it. */
  role: "primary" | "guard" | "tiebreak" | "reported";
  /** Cases both columns have a value for; each case's value is the mean of its trials. */
  cases: number;
  baseline: number | null;
  challenger: number | null;
  difference: number | null;
  /** The two-sided interval on the difference, at the comparison's confidence; absent below 5 cases. */
  interval?: [number, number];
  /** Cases where the column did better, the same, worse, by the metric's direction. */
  won: number;
  tied: number;
  lost: number;
};

/**
 * What a comparison says about a column. `stop` says whether a run should go on with it:
 * `undecided` with `stop` means the plan ran out without an answer, as when too few cases are won,
 * or the rule stopped early because more cases could not give an answer worth having.
 */
export type Verdict = {
  verdict: "better" | "worse" | "tie" | "undecided";
  /** Whether a run should run no more trials of this pair. */
  stop: boolean;
  /** One sentence a person reads first. */
  reason: string;
  metrics: ComparedMetric[];
};

export type ComparisonInput = {
  /** Every trial so far, per column, of the cases planned. */
  reference: readonly CaseScore[];
  column: readonly CaseScore[];
  metrics: readonly MetricSpec[];
  /**
   * How many cases the plan runs in all, a count: the dataset's size, whose seeded order the
   * cases come in. A rule's looks count towards it, and its last look is when all have run.
   */
  planned: number;
};

/** A rule over two columns' numbers, which `better.paired` wraps as a comparison export. */
export type Comparison = {
  /** In semver: the report names it, so a verdict says which rule gave it. */
  version: string;
  compare(input: ComparisonInput): Verdict;
};
