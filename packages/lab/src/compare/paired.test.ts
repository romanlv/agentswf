import { describe, expect, test } from "bun:test";
import { type CaseScore, type MetricSpec, pairedComparison } from ".";
import { obrienFleming, tQuantile } from "./stats";

// A synthetic kind of case: nothing of reviews, so the comparison is shown to need none.
const METRICS: MetricSpec[] = [
  { name: "score", direction: "higher", onVariantFailure: 0 },
  { name: "errors", direction: "lower", onVariantFailure: "missing" },
  { name: "cost", direction: "lower", onVariantFailure: "missing" },
];

function scores(
  values: readonly (readonly number[])[],
  extra: Partial<Record<string, number[]>> = {},
) {
  return values.flatMap((trials, c) =>
    trials.map(
      (score, t): CaseScore => ({
        case: `c${c}`,
        trial: t + 1,
        outcome: "scored",
        metrics: {
          score,
          errors: extra.errors?.[c] ?? 0,
          cost: extra.cost?.[c] ?? 1,
        },
      }),
    ),
  );
}

const standard = pairedComparison({
  primary: "score",
  guards: [{ metric: "errors", margin: 0.05 }],
  tiebreak: [{ metric: "cost", margin: 0.1 }],
  looks: [8, 16],
});

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
  test("t quantiles and O'Brien–Fleming bounds match the tables", () => {
    expect(tQuantile(0.975, 9)).toBeCloseTo(2.262, 3);
    expect(tQuantile(0.975, 4)).toBeCloseTo(2.776, 3);
    expect(obrienFleming([1], 0.025)).toBeCloseTo(1.96, 2);
    expect(obrienFleming([0.5, 1], 0.025)).toBeCloseTo(1.977, 2);
    expect(obrienFleming([1 / 3, 2 / 3, 1], 0.025)).toBeCloseTo(2.004, 2);
  });
});

describe("pairedComparison", () => {
  test("below 5 cases it gives counts only, and never stops", () => {
    const verdict = standard.compare({
      baseline: scores([[0.1], [0.2], [0.3], [0.4]]),
      challenger: scores([[0.5], [0.2], [0.6], [0.1]]),
      metrics: METRICS,
      selected: 16,
    });
    expect(verdict).toMatchObject({ verdict: "undecided", stop: false });
    expect(verdict.reason).toBe("4 cases: too few for an interval; won 2, tied 1, lost 1");
    expect(verdict.metrics[0]!.interval).toBeUndefined();
  });

  test("worse stops at any case count, not only at a look", () => {
    const baseline = scores(Array.from({ length: 6 }, () => [0.6, 0.6]));
    const challenger = scores(Array.from({ length: 6 }, (_, i) => [0.1 + i * 0.01, 0.2]));
    const verdict = standard.compare({ baseline, challenger, metrics: METRICS, selected: 16 });
    expect(verdict).toMatchObject({ verdict: "worse", stop: true });
    expect(verdict.reason).toStartWith("looked worse: score −");
  });

  test("better only at a look, and only with the guard shown within its margin", () => {
    const base = Array.from({ length: 8 }, (_, i) => [0.2 + (i % 3) * 0.05]);
    const up = base.map(([x], i) => [x! + 0.3 + (i % 2) * 0.05]);
    const at = (n: number, errors?: number[]) =>
      standard.compare({
        baseline: scores(base.slice(0, n)),
        challenger: scores(up.slice(0, n), errors ? { errors } : {}),
        metrics: METRICS,
        selected: 16,
      });
    expect(at(7).verdict).toBe("undecided");
    expect(at(7).reason).toContain("next look at 8");
    expect(at(8)).toMatchObject({ verdict: "better", stop: true });
    const noisy = at(8, [0, 0.3, 0, 0, 0.2, 0, 0, 0]);
    expect(noisy).toMatchObject({ verdict: "undecided", stop: false });
  });

  test("a guard past its margin is worse, whatever the primary", () => {
    const base = Array.from({ length: 8 }, () => [0.2]);
    const verdict = standard.compare({
      baseline: scores(base),
      challenger: scores(
        base.map(() => [0.9]),
        { errors: [0.5, 0.6, 0.5, 0.4, 0.5, 0.6, 0.5, 0.5] },
      ),
      metrics: METRICS,
      selected: 16,
    });
    expect(verdict).toMatchObject({ verdict: "worse", stop: true });
    expect(verdict.reason).toStartWith("errors worse by more than 0.05");
  });

  test("at the last look, no difference goes to the tie-breakers", () => {
    const base = Array.from({ length: 16 }, (_, i) => [0.3 + (i % 4) * 0.1]);
    const same = base.map(([x], i) => [x! + (i % 2 ? 0.05 : -0.05)]);
    const tie = standard.compare({
      baseline: scores(base),
      challenger: scores(same),
      metrics: METRICS,
      selected: 16,
    });
    expect(tie).toMatchObject({ verdict: "tie", stop: true });
    const cheaper = standard.compare({
      baseline: scores(base),
      challenger: scores(same, { cost: base.map((_, i) => 0.5 + (i % 3) * 0.01) }),
      metrics: METRICS,
      selected: 16,
    });
    expect(cheaper).toMatchObject({ verdict: "better", stop: true });
    expect(cheaper.reason).toContain("decided by cost −0.");
    // Cheaper, but not by more than the margin: still a tie.
    const barely = standard.compare({
      baseline: scores(base),
      challenger: scores(same, { cost: base.map((_, i) => 0.95 + (i % 3) * 0.01) }),
      metrics: METRICS,
      selected: 16,
    });
    expect(barely.verdict).toBe("tie");
  });

  test("a failed trial scores the metric's failure value, or is left out", () => {
    const failed: CaseScore = { case: "c0", trial: 1, outcome: "variant-failed", metrics: {} };
    const verdict = standard.compare({
      baseline: scores([[0.4]]),
      challenger: [failed],
      metrics: METRICS,
      selected: 16,
    });
    const [score, errors] = verdict.metrics;
    expect(score).toMatchObject({ cases: 1, challenger: 0, lost: 1 });
    expect(errors).toMatchObject({ cases: 0 });
  });

  test("naming a metric the scorer doesn't give is an error that lists the ones it does", () => {
    const wrong = pairedComparison({ primary: "recall" });
    expect(() =>
      wrong.compare({ baseline: [], challenger: [], metrics: METRICS, selected: 8 }),
    ).toThrow(
      "the comparison names recall, which the scorer doesn't give; it gives score, errors, cost",
    );
  });

  test("under no difference, checking after every case claims better at most 2.5% of the time", () => {
    const normal = gaussian(7);
    let better = 0;
    const runs = 2000;
    for (let run = 0; run < runs; run++) {
      const base: number[][] = [];
      const challenger: number[][] = [];
      for (let n = 1; n <= 16; n++) {
        const level = normal() * 0.19;
        base.push([level + normal() * 0.13, level + normal() * 0.13]);
        challenger.push([level + normal() * 0.13, level + normal() * 0.13]);
        const verdict = standard.compare({
          baseline: scores(base),
          challenger: scores(challenger),
          metrics: METRICS,
          selected: 16,
        });
        if (verdict.stop) {
          if (verdict.verdict === "better") better++;
          break;
        }
      }
    }
    expect(better / runs).toBeLessThanOrEqual(0.03);
  });
});
