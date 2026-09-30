import { describe, expect, test } from "bun:test";
import { type CaseScore, compareMetric, type MetricSpec, pairedComparison } from ".";
import { obrienFleming, tQuantile } from "./stats";

// A synthetic kind of case: nothing of reviews, so the comparison is shown to need none.
const METRICS: MetricSpec[] = [
  { name: "score", direction: "higher", onVariantFailure: 0 },
  { name: "errors", direction: "lower", onVariantFailure: "missing" },
  { name: "cost", direction: "lower", onVariantFailure: "missing" },
];

type Extra = Partial<Record<"errors" | "cost", (number | null)[]>>;

function scores(values: readonly (readonly number[])[], extra: Extra = {}): CaseScore[] {
  return values.flatMap((trials, c) =>
    trials.map(
      (score, t): CaseScore => ({
        case: `c${c}`,
        trial: t + 1,
        outcome: "scored",
        metrics: {
          score,
          errors: extra.errors === undefined ? 0 : (extra.errors[c] ?? null),
          cost: extra.cost === undefined ? 1 : (extra.cost[c] ?? null),
        },
      }),
    ),
  );
}

const standard = pairedComparison({
  version: "1.0.0",
  primary: "score",
  guards: [{ metric: "errors", margin: 0.05 }],
  equivalence: 0.1,
  tiebreak: [{ metric: "cost", margin: 0.1 }],
  looks: [8],
});

const compare = (baseline: CaseScore[], challenger: CaseScore[], planned = 16) =>
  standard.compare({ baseline, challenger, metrics: METRICS, planned });

/** Values with a mean and some spread, so an interval has a width. */
const around = (n: number, level: number, step = 0.05) =>
  Array.from({ length: n }, (_, i) => [level + ((i % 3) - 1) * step]);

/** A seeded normal, so a failing simulation fails the same way twice. */
function gaussian(seed: number) {
  let state = seed;
  const uniform = () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return (state + 0.5) / 2 ** 32;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

describe("stats", () => {
  test("t quantiles match the tables, far into the tails", () => {
    expect(tQuantile(0.975, 9)).toBeCloseTo(2.2622, 4);
    expect(tQuantile(0.975, 4)).toBeCloseTo(2.7764, 4);
    expect(tQuantile(0.025, 9)).toBeCloseTo(-2.2622, 4);
    expect(tQuantile(0.9999, 1)).toBeCloseTo(3183.1, 1);
  });

  test("O'Brien–Fleming bounds match a multivariate normal's, equal looks or not", () => {
    const equal = (k: number) => Array.from({ length: k }, (_, i) => (i + 1) / k);
    expect(obrienFleming([1], 0.025)).toBeCloseTo(1.96, 3);
    expect(obrienFleming(equal(2), 0.025)).toBeCloseTo(1.9774, 3);
    expect(obrienFleming(equal(3), 0.025)).toBeCloseTo(2.004, 3);
    expect(obrienFleming(equal(6), 0.025)).toBeCloseTo(2.0528, 3);
    expect(obrienFleming([0.9, 1], 0.025)).toBeCloseTo(2.0259, 3);
  });
});

describe("pairedComparison", () => {
  test("below 5 cases it gives counts only, and stops only when the plan has run", () => {
    const base = scores([[0.1], [0.2], [0.3], [0.4]]);
    const other = scores([[0.5], [0.2], [0.6], [0.1]]);
    const four = compare(base, other);
    expect(four).toMatchObject({ verdict: "undecided", stop: false });
    expect(four.reason).toBe(
      "4 cases with score: too few for an interval; won 2, tied 1, lost 1; at 4 of 16 cases, next look at 8",
    );
    expect(four.metrics[0]!.interval).toBeUndefined();
    expect(compare(base, other, 4)).toMatchObject({ verdict: "undecided", stop: true });
  });

  test("worse stops at any case count, not only at a look", () => {
    const verdict = compare(scores(around(6, 0.6)), scores(around(6, 0.15)));
    expect(verdict).toMatchObject({ verdict: "worse", stop: true });
    expect(verdict.reason).toStartWith("stopped, looked worse: score −0.45");
  });

  test("better only at a look, and only with the guard shown within its margin", () => {
    const base = around(8, 0.2);
    const up = base.map(([x], i) => [x! + 0.3 + (i % 2) * 0.05]);
    const at = (n: number, errors?: number[]) =>
      compare(scores(base.slice(0, n)), scores(up.slice(0, n), errors ? { errors } : {}));
    expect(at(7)).toMatchObject({ verdict: "undecided", stop: false });
    expect(at(7).reason).toContain("next look at 8");
    expect(at(8)).toMatchObject({ verdict: "better", stop: true });
    const noisy = at(8, [0, 0.3, 0, 0, 0.2, 0, 0, 0]);
    expect(noisy).toMatchObject({ verdict: "undecided", stop: false });
    expect(noisy.reason).toContain("past the bound, but not shown within margin: errors");
  });

  test("a guard with too few values says so, and blocks better at the last look", () => {
    const base = around(8, 0.2);
    const up = base.map(([x], i) => [x! + 0.3 + (i % 2) * 0.05]);
    const sparse = [0, null, null, 0, null, null, null, 0];
    const verdict = compare(scores(base, { errors: sparse }), scores(up, { errors: sparse }), 8);
    expect(verdict).toMatchObject({ verdict: "undecided", stop: true });
    expect(verdict.reason).toContain("not shown within margin: errors (3 cases)");
  });

  test("a guard past its margin is worse, whatever the primary", () => {
    const verdict = compare(
      scores(around(8, 0.2)),
      scores(around(8, 0.9), { errors: [0.5, 0.6, 0.5, 0.4, 0.5, 0.6, 0.5, 0.5] }),
    );
    expect(verdict).toMatchObject({ verdict: "worse", stop: true });
    expect(verdict.reason).toStartWith("stopped, errors worse by more than 0.05");
  });

  test("at the last look, a primary shown equivalent goes to the tie-breakers, by their margins", () => {
    const base = around(16, 0.5);
    const same = base.map(([x], i) => [x! + (i % 2 ? 0.01 : -0.01)]);
    const cost = (level: number) => base.map((_, i) => level + (i % 3) * 0.01);
    expect(compare(scores(base), scores(same))).toMatchObject({ verdict: "tie", stop: true });
    const cheaper = compare(scores(base, { cost: cost(1) }), scores(same, { cost: cost(0.5) }));
    expect(cheaper).toMatchObject({ verdict: "better", stop: true });
    expect(cheaper.reason).toContain("decided by cost −0.5");
    const barely = compare(scores(base, { cost: cost(1) }), scores(same, { cost: cost(0.95) }));
    expect(barely.verdict).toBe("tie");
    const dearer = compare(scores(base, { cost: cost(0.5) }), scores(same, { cost: cost(1) }));
    expect(dearer).toMatchObject({ verdict: "worse", stop: true });
  });

  test("no tie-breaker decides while the primary may still differ by more than the equivalence", () => {
    const base = around(16, 0.5, 0.3);
    const lower = base.map(([x], i) => [x! - 0.1 + (i % 2 ? 0.25 : -0.25)]);
    const verdict = compare(
      scores(base, { cost: base.map(() => 1) }),
      scores(lower, { cost: base.map(() => 0.1) }),
    );
    expect(verdict).toMatchObject({ verdict: "tie", stop: true });
    expect(verdict.reason).toContain("not shown within ±0.1, so no tie-breaker");
  });

  test("a gain short of the bound at the last look is undecided, not no difference", () => {
    const loose = pairedComparison({
      version: "1.0.0",
      primary: "score",
      looks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      minDiffering: 0,
    });
    // Eight at +0.316 and eight at −0.084, t ≈ 2.25: past the plain 97.5% quantile (2.13), short
    // of the bound that eleven earlier looks set (2.33).
    const gains = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.3162 : -0.0838));
    const verdict = loose.compare({
      baseline: scores(gains.map(() => [0.5])),
      challenger: scores(gains.map((g) => [0.5 + g])),
      metrics: METRICS,
      planned: 16,
    });
    expect(verdict.metrics[0]!.interval![0]).toBeGreaterThan(0);
    expect(verdict).toMatchObject({ verdict: "undecided", stop: true });
    expect(verdict.reason).toContain("a gain, but not past the bound");
  });

  test("the last look comes when every planned case has run, whichever the primary has", () => {
    const base = around(12, 0.2);
    const up = base.map(([x], i) => [x! + 0.3 + (i % 2) * 0.05]);
    // The primary is null on one case both variants finished: the plan has still run.
    const challenger = scores(up).map((s) =>
      s.case === "c3" ? { ...s, metrics: { ...s.metrics, score: null } } : s,
    );
    const verdict = compare(scores(base), challenger, 12);
    expect(verdict).toMatchObject({ verdict: "better", stop: true });
    expect(verdict.metrics[0]!.cases).toBe(11);
  });

  test("differences within rounding are ties, not a gain", () => {
    const base = Array.from({ length: 8 }, () => [0.1, 0.1, 0.4]);
    const challenger = Array.from({ length: 8 }, () => [0.4, 0.1, 0.1]);
    const verdict = compare(scores(base), scores(challenger), 8);
    expect(verdict.metrics[0]).toMatchObject({ won: 0, tied: 8, lost: 0 });
    expect(verdict.verdict).toBe("tie");
  });

  test("a failed trial scores the metric's failure value, or is left out", () => {
    const failed: CaseScore = { case: "c0", trial: 2, outcome: "variant-failed", metrics: {} };
    const verdict = compare(scores([[0.4]]), [...scores([[0.6]]), failed]);
    const [score, errors] = verdict.metrics;
    expect(score).toMatchObject({ cases: 1, challenger: 0.3 });
    expect(errors).toMatchObject({ cases: 1, challenger: 0 });
  });

  test("a value that isn't a number is an error naming the case", () => {
    const bad = scores(around(8, 0.5)).map((s) =>
      s.case === "c2" ? { ...s, metrics: { ...s.metrics, score: Number.NaN } } : s,
    );
    expect(() => compare(scores(around(8, 0.5)), bad)).toThrow("score is NaN on c2, trial 1");
  });

  test("naming a metric the scorer doesn't give is an error that lists the ones it does", () => {
    const wrong = pairedComparison({ version: "1.0.0", primary: "recall" });
    expect(() =>
      wrong.compare({ baseline: [], challenger: [], metrics: METRICS, planned: 8 }),
    ).toThrow(
      "the comparison names recall, which the scorer doesn't give; it gives score, errors, cost",
    );
    expect(() =>
      pairedComparison({
        version: "1.0.0",
        primary: "score",
        tiebreak: [{ metric: "cost", margin: 1 }],
      }),
    ).toThrow("tie-breakers need an equivalence");
  });

  test("compareMetric gives only what a report prints", () => {
    const compared = compareMetric(
      { baseline: scores(around(5, 0.2)), challenger: scores(around(5, 0.4)) },
      METRICS[0]!,
    );
    expect(Object.keys(compared).sort()).toEqual([
      "baseline",
      "cases",
      "challenger",
      "difference",
      "interval",
      "lost",
      "name",
      "role",
      "tied",
      "won",
    ]);
  });

  test("under no difference, checked after every case, better stays near 2.5%", () => {
    const normal = gaussian(7);
    const tally = { better: 0, worse: 0 };
    const runs = 4000;
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      guards: [{ metric: "errors", margin: 0.05 }],
      looks: [8],
    });
    for (let run = 0; run < runs; run++) {
      const base: number[][] = [];
      const challenger: number[][] = [];
      const errors: number[] = [];
      for (let n = 1; n <= 16; n++) {
        const level = normal() * 0.19;
        base.push([level + normal() * 0.13, level + normal() * 0.13]);
        challenger.push([level + normal() * 0.13, level + normal() * 0.13]);
        errors.push(Math.abs(normal()) * 0.02);
        const verdict = rule.compare({
          baseline: scores(base),
          challenger: scores(challenger, { errors }),
          metrics: METRICS,
          planned: 16,
        });
        if (verdict.stop) {
          if (verdict.verdict === "better") tally.better++;
          if (verdict.verdict === "worse") tally.worse++;
          break;
        }
      }
    }
    // 2.5% nominal; the t bound at each look is an approximation, measured at 2.4–2.8%.
    expect(tally.better / runs).toBeLessThanOrEqual(0.03);
    // The price of stopping as soon as a loser shows: measured at 7–9% with 16 cases.
    expect(tally.worse / runs).toBeLessThanOrEqual(0.12);
  });
});
