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
    expect(verdict).toMatchObject({ verdict: "undecided", stop: true });
    expect(verdict.reason).toContain("no difference shown, nor one within ±0.1");
  });

  test("a primary slightly better, and within the equivalence, still goes to the tie-breakers", () => {
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      looks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      equivalence: 0.3,
      tiebreak: [{ metric: "cost", margin: 0.1 }],
    });
    // A gain past the plain interval, short of the bound that eleven looks set, within ±0.3.
    const gains = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.3162 : -0.0838));
    const cost = gains.map(() => 1);
    const verdict = rule.compare({
      baseline: scores(
        gains.map(() => [0.5]),
        { cost },
      ),
      challenger: scores(
        gains.map((g) => [0.5 + g]),
        { cost: cost.map(() => 0.5) },
      ),
      metrics: METRICS,
      planned: 16,
    });
    expect(verdict.metrics[0]!.interval![0]).toBeGreaterThan(0);
    expect(verdict).toMatchObject({ verdict: "better", stop: true });
    expect(verdict.reason).toContain("decided by cost −0.50");
  });

  test("the first tie-breaker past its margin decides, either way", () => {
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      guards: [{ metric: "errors", margin: 0.05 }],
      equivalence: 0.1,
      tiebreak: [
        { metric: "cost", margin: 0.1 },
        { metric: "errors", margin: 0.01 },
      ],
    });
    const base = around(16, 0.5);
    const same = base.map(([x], i) => [x! + (i % 2 ? 0.01 : -0.01)]);
    const sparse = base.map((_, i) => (i < 3 ? 0 : null));
    // Cheaper, but the guard has too few values to be shown within its margin.
    const verdict = rule.compare({
      baseline: scores(base, { cost: base.map(() => 1), errors: sparse }),
      challenger: scores(same, { cost: base.map(() => 0.5), errors: sparse }),
      metrics: METRICS,
      planned: 16,
    });
    expect(verdict).toMatchObject({ verdict: "undecided", stop: true });
    expect(verdict.reason).toStartWith("decided by cost −0.50");
    expect(verdict.reason).toEndWith("but not shown within margin: errors (3 cases)");
  });

  test("improving the challenger never loses it a verdict, at the equivalence's edges too", () => {
    const base = around(20, 0.5, 0.02);
    const noise = base.map((_, i) => ((i * 7) % 5) * 0.01 - 0.02);
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      looks: [8, 16],
      equivalence: 0.05,
      tiebreak: [{ metric: "cost", margin: 0.1 }],
    });
    const at = (shift: number, cost: number) =>
      rule.compare({
        baseline: scores(base, { cost: base.map(() => 1) }),
        challenger: scores(
          base.map(([x], i) => [x! + shift + noise[i]!]),
          { cost: base.map(() => cost) },
        ),
        metrics: METRICS,
        planned: 20,
      }).verdict;
    // Cheaper: better stays better as the primary rises through the band's upper edge.
    for (const shift of [0, 0.02, 0.03, 0.04, 0.06]) expect(at(shift, 0.8)).toBe("better");
    // Dearer: worse stays worse as the primary falls through its lower edge.
    for (const shift of [0, -0.02, -0.03, -0.04]) expect(at(shift, 1.2)).toBe("worse");
  });

  test("a tie-breaker that may differ either way beyond its margin stops the chain, and says so", () => {
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      equivalence: 0.1,
      tiebreak: [
        { metric: "cost", margin: 0.1 },
        { metric: "errors", margin: 0.01 },
      ],
    });
    const base = around(16, 0.5);
    const same = base.map(([x], i) => [x! + (i % 2 ? 0.01 : -0.01)]);
    const verdict = rule.compare({
      baseline: scores(base, { cost: base.map(() => 1), errors: base.map(() => 0.5) }),
      // Cost wanders both ways past its margin; errors are clearly lower, but come second.
      challenger: scores(same, {
        cost: base.map((_, i) => (i % 2 ? 1.5 : 0.7)),
        errors: base.map(() => 0),
      }),
      metrics: METRICS,
      planned: 16,
    });
    expect(verdict).toMatchObject({ verdict: "tie", stop: true });
    expect(verdict.reason).toContain("cost not shown within its margin");
  });

  test("cheaper on an earlier tie-breaker never costs the verdict a later one gives", () => {
    const METRICS2: MetricSpec[] = [
      ...METRICS,
      { name: "time", direction: "lower", onVariantFailure: "missing" },
    ];
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      equivalence: 0.05,
      tiebreak: [
        { metric: "cost", margin: 0.05 },
        { metric: "time", margin: 30 },
      ],
    });
    const base = around(16, 0.5);
    const same = base.map(([x], i) => [x! + (i % 2 ? 0.01 : -0.01)]);
    const withTime = (list: CaseScore[], time: number) =>
      list.map((c, i) => ({ ...c, metrics: { ...c.metrics, time: time + (i % 3) } }));
    const at = (saving: number) =>
      rule.compare({
        baseline: withTime(scores(base, { cost: base.map((_, i) => 1 + (i % 3) * 0.01) }), 120),
        challenger: withTime(
          scores(same, { cost: base.map((_, i) => 1 - saving + ((i + 1) % 3) * 0.01) }),
          60,
        ),
        metrics: METRICS2,
        planned: 16,
      }).verdict;
    // Faster by a minute; cost from the same to past its margin, through its edge.
    for (const saving of [0, 0.02, 0.04, 0.05, 0.06, 0.1]) expect(at(saving)).toBe("better");
  });

  test("the floor counts cases won, so a challenger that improves never falls below it", () => {
    const rule = pairedComparison({ version: "1.0.0", primary: "score" });
    // Five clear wins and five ties on a coarse score, then the same a little lower everywhere.
    const base = Array.from({ length: 10 }, () => [0.5]);
    const ours = base.map((_, i) => [i < 5 ? 0.5 + 0.2 + (i % 2) * 0.05 : 0.5]);
    const at = (shift: number) =>
      rule.compare({
        baseline: scores(base),
        challenger: scores(ours.map(([x]) => [x! + shift])),
        metrics: METRICS,
        planned: 10,
      });
    expect(at(0).reason).toContain("only 5 cases won, 6 needed");
    expect(at(-0.001).verdict).not.toBe("better");
  });

  test("an outcome the rule doesn't know counts as missing, not as a finished case", () => {
    const base = scores(around(6, 0.5));
    const ours = scores(around(6, 0.5)).map((s) =>
      s.case === "c5" ? { ...s, outcome: "environment-failed" as never } : s,
    );
    expect(compare(base, ours, 6)).toMatchObject({ verdict: "undecided", stop: false });
  });

  test("a primary shown within the equivalence is a tie, even a little better", () => {
    const rule = pairedComparison({
      version: "1.0.0",
      primary: "score",
      looks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      equivalence: 0.3,
    });
    // Past the plain interval, short of the bound that eleven looks set, within ±0.3.
    const gains = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.3162 : -0.0838));
    const verdict = rule.compare({
      baseline: scores(gains.map(() => [0.5])),
      challenger: scores(gains.map((g) => [0.5 + g])),
      metrics: METRICS,
      planned: 16,
    });
    expect(verdict.metrics[0]!.interval![0]).toBeGreaterThan(0);
    expect(verdict).toMatchObject({ verdict: "tie", stop: true });
    expect(verdict.reason).toStartWith("within ±0.3");
  });

  test("options that can't mean anything are refused when the rule is made", () => {
    expect(() => pairedComparison({ version: "1", primary: "score" })).toThrow("version 1 is not");
    expect(() =>
      pairedComparison({
        version: "1.0.0",
        primary: "score",
        guards: [{ metric: "errors", margin: -1 }],
      }),
    ).toThrow("errors's margin is -1");
    expect(() =>
      pairedComparison({ version: "1.0.0", primary: "score", equivalence: -0.1 }),
    ).toThrow("equivalence's margin is -0.1");
    expect(() => pairedComparison({ version: "1.0.0", primary: "score", looks: [0] })).toThrow(
      "looks are case counts",
    );
    expect(() => pairedComparison({ version: "1.0.0", primary: "score", looks: [6.5] })).toThrow(
      "looks are case counts",
    );
    expect(() => pairedComparison({ version: "1.0.0", primary: "score", minWon: -1 })).toThrow(
      "minWon is a count",
    );
    expect(() =>
      standard.compare({ baseline: [], challenger: [], metrics: METRICS, planned: 0 }),
    ).toThrow("planned is a count of cases");
  });

  test("a gain short of the bound at the last look is undecided, not no difference", () => {
    const loose = pairedComparison({
      version: "1.0.0",
      primary: "score",
      looks: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      minWon: 0,
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
