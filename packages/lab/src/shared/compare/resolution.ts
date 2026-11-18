import { perCase } from "./paired";
import { mean, tQuantile } from "./stats";
import type { CaseScore, MetricSpec } from "./types";

/** How one metric varies: between cases' means, and between trials of one case. */
export type Variance = {
  cases: number;
  /** Trials a case, on average. */
  trials: number;
  mean: number | null;
  /** The variance of the cases' true values; null below two cases. */
  between: number | null;
  /** The variance of one case's trials, pooled; null until some case has two. */
  within: number | null;
};

/**
 * One metric's variance components from one variant's trials: the within-case variance pooled over
 * cases with two trials or more, and the between-case variance as the case means' variance less
 * what their trials' noise adds to it, never below 0.
 */
export function varianceOf(scores: readonly CaseScore[], metric: MetricSpec): Variance {
  const byCase = new Map<string, number[]>();
  for (const score of scores) {
    const value = perCase([score], metric).get(score.case);
    if (value !== undefined) byCase.set(score.case, [...(byCase.get(score.case) ?? []), value]);
  }
  const groups = [...byCase.values()];
  const means = groups.map(mean);
  let squares = 0;
  let freedom = 0;
  for (const [i, xs] of groups.entries()) {
    for (const x of xs) squares += (x - means[i]!) ** 2;
    freedom += xs.length - 1;
  }
  const within = freedom > 0 ? squares / freedom : null;
  const spread =
    means.length > 1
      ? means.reduce((sum, m) => sum + (m - mean(means)) ** 2, 0) / (means.length - 1)
      : null;
  const noise = within === null ? 0 : within * mean(groups.map((xs) => 1 / xs.length));
  return {
    cases: groups.length,
    trials: groups.length === 0 ? 0 : mean(groups.map((xs) => xs.length)),
    mean: means.length === 0 ? null : mean(means),
    between: spread === null ? null : Math.max(0, spread - noise),
    within,
  };
}

/** The smallest variance assumed for the true per-case difference between two variants. */
const LEAST = 0.01;

/**
 * The smallest difference `cases` cases of `trials` trials each detect at 80% power by a paired t
 * test at 5%, two-sided, as the comparison's interval is: a range, as the variance of the true
 * per-case difference between two variants is unknown, from 0.01 to the between-case variance. Each variant's trials add `within / trials` to it.
 */
export function resolution(
  variance: Pick<Variance, "between" | "within">,
  cases: number,
  trials: number,
): [number, number] | null {
  return scaled(variance, cases, trials, (n) => tQuantile(0.975, n - 1) + tQuantile(0.8, n - 1));
}

/**
 * How close to 0 a tie can be shown at best: the 95% interval's half-width when the two variants
 * are equal, over the same range as `resolution`. An equivalence margin below it is seldom reached.
 */
export function tieReach(
  variance: Pick<Variance, "between" | "within">,
  cases: number,
  trials: number,
): [number, number] | null {
  return scaled(variance, cases, trials, (n) => tQuantile(0.975, n - 1));
}

function scaled(
  variance: Pick<Variance, "between" | "within">,
  cases: number,
  trials: number,
  quantile: (cases: number) => number,
): [number, number] | null {
  const { between, within } = variance;
  if (between === null || within === null || cases < 2) return null;
  const noise = (2 * within) / trials;
  const [low, high] = [Math.min(LEAST, between), Math.max(LEAST, between)];
  const t = quantile(cases);
  return [t * Math.sqrt((low + noise) / cases), t * Math.sqrt((high + noise) / cases)];
}
