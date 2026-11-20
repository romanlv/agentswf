import type { CaseRow } from "./outcome";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// How sure a column's pass rate is. Cases are the independent units: trials of one case share its
// input and are never pooled as if independent. The intervals are 95%.

const Z = 1.96;

/** Student's t at 97.5% by degrees of freedom, for intervals from a few cases; Z beyond 30. */
const T = [
  12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12,
  2.11, 2.1, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04,
];
const tOf = (df: number) => T[df - 1] ?? Z;

export type Interval = [low: number, high: number];

const clip = (x: number) => Math.min(1, Math.max(0, x));

/** Wilson's interval for x of n, which stays inside 0 to 1 and is sound at small n. */
export function wilson(x: number, n: number): Interval | undefined {
  if (n === 0) return undefined;
  const p = x / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [clip(centre - half), clip(centre + half)];
}

/** A mean of per-case values with its interval from their spread across cases. */
export function meanWithInterval(
  values: readonly number[],
  bounds: Interval = [0, 1],
): { mean: number; interval?: Interval } | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const half = tOf(n - 1) * Math.sqrt(variance / n);
  const [lo, hi] = bounds;
  return { mean, interval: [Math.max(lo, mean - half), Math.min(hi, mean + half)] };
}

export type Rates = {
  /** Cases with a verdict, and how many passed. */
  cases: number;
  passed: number;
  interval?: Interval;
  /** With more than one trial a case: the mean of each case's pass fraction. */
  mean?: { mean: number; interval?: Interval };
  /** At k trials a case, every case run k times: those whose k trials all passed, and any. */
  k?: number;
  passAll?: number;
  passAny?: number;
};

/** The trials of a case that a verdict counts, and how many of them passed. */
const graded = (row: CaseRow) => row.tally.trials > 0 && row.tally.verdict !== undefined;

export function ratesOf(rows: readonly CaseRow[]): Rates {
  const counted = rows.filter(graded);
  const passed = counted.filter((r) => r.tally.verdict === "passed").length;
  const interval = wilson(passed, counted.length);
  const rates: Rates = { cases: counted.length, passed, ...(interval ? { interval } : {}) };
  const trials = new Set(counted.map((r) => r.tally.trials));
  if (counted.length > 0 && [...trials].some((t) => t > 1)) {
    const mean = meanWithInterval(counted.map((r) => r.tally.passed / r.tally.trials));
    if (mean) rates.mean = mean;
  }
  if (trials.size === 1) {
    const k = [...trials][0]!;
    if (k > 1) {
      rates.k = k;
      rates.passAll = counted.filter((r) => r.tally.passed === k).length;
      rates.passAny = counted.filter((r) => r.tally.passed > 0).length;
    }
  }
  return rates;
}

/**
 * A column's difference from the reference on the same cases: the mean of each case's pass
 * fraction there less the reference's, with its interval from the per-case differences. Two
 * columns' own intervals can overlap while this one is clear of 0.
 */
export function pairedDifference(
  reference: readonly CaseRow[],
  other: readonly CaseRow[],
): { cases: number; mean: number; interval?: Interval; shown: boolean } | undefined {
  const theirs = new Map(other.filter(graded).map((r) => [r.name, r]));
  const differences = reference.filter(graded).flatMap((mine) => {
    const there = theirs.get(mine.name);
    return there
      ? [there.tally.passed / there.tally.trials - mine.tally.passed / mine.tally.trials]
      : [];
  });
  const found = meanWithInterval(differences, [-1, 1]);
  if (!found) return undefined;
  return { cases: differences.length, ...found, shown: signTest(differences) < 0.05 };
}

/**
 * The two-sided sign test on the cases that came out differently: how likely so many went one
 * way if neither column were better. Sound at a few cases, where an interval from their spread
 * says too much (every case moving alike has no spread at all).
 */
export function signTest(differences: readonly number[]): number {
  const moved = differences.filter((d) => d !== 0);
  const m = moved.length;
  if (m === 0) return 1;
  const up = moved.filter((d) => d > 0).length;
  const tail = Math.min(up, m - up);
  let choose = 1;
  let sum = 0;
  for (let i = 0; i <= tail; i++) {
    sum += choose;
    choose = (choose * (m - i)) / (i + 1);
  }
  return Math.min(1, (2 * sum) / 2 ** m);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const range = ([lo, hi]: Interval) => `${Math.round(lo * 100)}–${pct(hi)}`;
const points = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x * 100))}`;

/** `5/7 cases passed, 95% 36–92% · mean per case 81%, 95% 62–100% · pass^3 4/7 · pass@3 6/7`. */
export function describeRates(rates: Rates): string {
  if (rates.cases === 0) return "no case graded";
  const parts = [
    `${rates.passed}/${rates.cases} cases passed${rates.interval ? `, 95% ${range(rates.interval)}` : ""}`,
  ];
  if (rates.mean) {
    parts.push(
      `mean per case ${pct(rates.mean.mean)}${rates.mean.interval ? `, 95% ${range(rates.mean.interval)}` : ""}`,
    );
  }
  if (rates.k !== undefined) {
    parts.push(`pass^${rates.k} ${rates.passAll}/${rates.cases}`);
    parts.push(`pass@${rates.k} ${rates.passAny}/${rates.cases}`);
  }
  return parts.join(" · ");
}

/** `−14 points, 95% −40 to +11: no difference shown`. */
export function describeDifference(d: NonNullable<ReturnType<typeof pairedDifference>>): string {
  const interval = d.interval ? `, 95% ${points(d.interval[0])} to ${points(d.interval[1])}` : "";
  return `${points(d.mean)} points on ${plural(d.cases, "case")}${interval}${d.shown ? "" : ": no difference shown"}`;
}
