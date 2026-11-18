import {
  type CaseScore,
  type MetricSpec,
  type PairedOptions,
  pairedComparison,
  type Verdict,
} from "../../shared/compare";
import { checkVersion, DEFAULT_VERSION } from "../../shared/version";

// What "better" means for a dataset: `export const compare = …` in its graders.ts. The lab gives
// it every trial of the reference column and of one other, and it says whether the other is
// better, worse, a tie or undecided, with a reason and whether more trials could change that.

/** What a comparison export carries, checked by the helper that loads `graders.ts`. */
export const COMPARISON_KIND = "awf.case-comparison/0";

/** One trial, as a comparison sees it. */
export type ComparedTrial = {
  case: string;
  trial: number;
  /** The lab's verdict on it: true passed, false failed, null neither (undecided, numbers only). */
  passed: boolean | null;
  /** The workflow erred: its body failed, timed out or stopped. Its numbers are what `onFailure` says. */
  workflowFailed: boolean;
  /** Each deciding grader's numbers, as `{grader}.{number}`: a count as its fraction, or a value. */
  numbers: Readonly<Record<string, number>>;
  /** The workflow's estimated cost, in dollars, when it was priced. */
  cost: number | null;
  /** The trial's time, in seconds. */
  seconds: number;
};

export type ComparisonCall = {
  reference: readonly ComparedTrial[];
  column: readonly ComparedTrial[];
  /** The cases the run asked for: a sequential rule's last look. */
  planned: number;
};

export type CaseComparison = {
  readonly kind: typeof COMPARISON_KIND;
  readonly version: string;
  compare(call: ComparisonCall): Verdict;
};

export type { Verdict };

/** A comparison of your own: `compare` gets both columns' trials and returns the verdict. */
export function defineComparison(options: {
  /** Semver; bump it whenever the rule changes, as the report names it beside each verdict. */
  version?: string;
  compare(call: ComparisonCall): Verdict;
}): CaseComparison {
  const version = options.version ?? DEFAULT_VERSION;
  const bad = checkVersion(version);
  if (bad) throw new Error(`defineComparison: ${bad}`);
  return { kind: COMPARISON_KIND, version, compare: options.compare };
}

/** How a metric is read: which way is better, and what a trial whose workflow failed scores. */
export type MetricOptions = {
  direction?: "higher" | "lower";
  /** A failed workflow's value, such as 0 recall; "missing" leaves the trial out. */
  onFailure?: number | "missing";
};

/**
 * A metric's name: `passed` (1 or 0), `cost`, `seconds`, or a grader's number,
 * `{grader}.{number}`. `cost` and `seconds` are better lower; the rest higher, unless told.
 */
export type MetricName = string;

const LOWER = new Set(["cost", "seconds"]);

function metricOf(trial: ComparedTrial, name: MetricName): number | null {
  if (name === "passed") return trial.passed === null ? null : trial.passed ? 1 : 0;
  if (name === "cost") return trial.cost;
  if (name === "seconds") return trial.seconds;
  return trial.numbers[name] ?? null;
}

function scoresOf(trials: readonly ComparedTrial[], names: readonly MetricName[]): CaseScore[] {
  return trials.map((t) => ({
    case: t.case,
    trial: t.trial,
    // A failed workflow's `passed` is a result, 0: only its other numbers go by `onFailure`.
    outcome: t.workflowFailed ? "variant-failed" : "scored",
    metrics: Object.fromEntries(names.map((name) => [name, metricOf(t, name)])),
  }));
}

function specOf(name: MetricName, options: MetricOptions | undefined): MetricSpec {
  return {
    name,
    direction: options?.direction ?? (LOWER.has(name) ? "lower" : "higher"),
    onVariantFailure: name === "passed" ? 0 : (options?.onFailure ?? "missing"),
  };
}

type Paired = Omit<PairedOptions, "primary" | "guards" | "tiebreak" | "version"> & {
  /** The metric that decides. */
  primary: MetricName;
  /** Metrics that may not get worse by more than `margin`. */
  guards?: readonly { metric: MetricName; margin: number }[];
  /** Metrics that decide, in order, when the primary is shown equal. */
  tiebreak?: readonly { metric: MetricName; margin: number }[];
  /** How each metric named is read, by name. */
  metrics?: Readonly<Record<MetricName, MetricOptions>>;
  version?: string;
};

export const better = {
  /**
   * The review loop's sequential paired rule: per-case differences on the same cases, "better"
   * claimed only past an O'Brien–Fleming bound at the planned looks, so it can stop as soon as it
   * can tell; guards that may not get worse; tie-breakers.
   */
  paired(options: Paired): CaseComparison {
    const { metrics, version, ...rule } = options;
    const names = [
      ...new Set([
        rule.primary,
        ...(rule.guards ?? []).map((g) => g.metric),
        ...(rule.tiebreak ?? []).map((t) => t.metric),
      ]),
    ];
    const specs = names.map((name) => specOf(name, metrics?.[name]));
    const comparison = pairedComparison({ ...rule, version: version ?? DEFAULT_VERSION });
    return defineComparison({
      ...(version ? { version } : {}),
      compare: ({ reference, column, planned }) =>
        comparison.compare({
          baseline: scoresOf(reference, names),
          challenger: scoresOf(column, names),
          metrics: specs,
          planned,
        }),
    });
  },

  /**
   * Better on the mean of one number of your own per trial, paired by case; `onFailure` is what a
   * trial whose workflow failed scores, `missing` leaving it out.
   */
  mean(
    value: (trial: ComparedTrial) => number | null,
    options: MetricOptions & { version?: string } = {},
  ): CaseComparison {
    const spec: MetricSpec = {
      name: "value",
      direction: options.direction ?? "higher",
      onVariantFailure: options.onFailure ?? "missing",
    };
    const comparison = pairedComparison({
      primary: "value",
      version: options.version ?? DEFAULT_VERSION,
    });
    const scores = (trials: readonly ComparedTrial[]): CaseScore[] =>
      trials.map((t) => ({
        case: t.case,
        trial: t.trial,
        outcome: t.workflowFailed ? "variant-failed" : "scored",
        metrics: { value: t.workflowFailed ? null : value(t) },
      }));
    return defineComparison({
      ...(options.version ? { version: options.version } : {}),
      compare: ({ reference, column, planned }) =>
        comparison.compare({
          baseline: scores(reference),
          challenger: scores(column),
          metrics: [spec],
          planned,
        }),
    });
  },
};
