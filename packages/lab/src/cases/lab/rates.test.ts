import { describe, expect, test } from "bun:test";
import type { CaseRow } from "./outcome";
import {
  describeDifference,
  describeRates,
  meanWithInterval,
  pairedDifference,
  ratesOf,
  signTest,
  wilson,
} from "./rates";

const row = (name: string, passed: number, trials: number): CaseRow => ({
  name,
  tally: {
    verdict: passed === trials ? "passed" : passed === 0 ? "failed" : "flaky",
    passed,
    failed: trials - passed,
    trials,
    need: trials,
  },
  knownFailing: false,
  brokenTrial: false,
  labTrial: false,
  outcomes: [],
  notes: [],
  history: [],
});

const near = (got: readonly number[] | undefined, want: readonly number[]) => {
  expect(got).toBeDefined();
  for (const [i, x] of got!.entries()) expect(x).toBeCloseTo(want[i]!, 3);
};

describe("how sure a rate is", () => {
  test("Wilson's interval matches worked numbers, and stays inside 0 to 1", () => {
    near(wilson(5, 7), [0.359, 0.918]);
    near(wilson(0, 10), [0, 0.278]);
    near(wilson(10, 10), [0.722, 1]);
    expect(wilson(0, 0)).toBeUndefined();
  });

  test("a mean of per-case fractions takes its interval from their spread, by Student's t", () => {
    const found = meanWithInterval([1, 1, 0.5, 0.5])!;
    expect(found.mean).toBeCloseTo(0.75, 6);
    // sd 0.2887 over 2, times t(3) 3.18.
    near(found.interval, [0.291, 1]);
    expect(meanWithInterval([0.5])).toEqual({ mean: 0.5 });
  });

  test("pass^k needs every trial of a case to pass, pass@k one", () => {
    const rates = ratesOf([row("a", 3, 3), row("b", 2, 3), row("c", 0, 3)]);
    expect(rates).toMatchObject({ cases: 3, passed: 1, k: 3, passAll: 1, passAny: 2 });
    expect(rates.mean!.mean).toBeCloseTo(5 / 9, 6);
    expect(describeRates(rates)).toMatch(
      /^1\/3 cases passed, 95% \d+–\d+% · mean per case 56%, 95% 0–\d+% · pass\^3 1\/3 · pass@3 2\/3$/,
    );
    // One trial each: no mean, no pass^k.
    expect(ratesOf([row("a", 1, 1), row("b", 0, 1)])).toEqual({
      cases: 2,
      passed: 1,
      interval: wilson(1, 2)!,
    });
  });

  test("the sign test: six cases one way show a difference, five do not", () => {
    expect(signTest([1, 1, 1, 1, 1, 1])).toBeCloseTo(0.03125, 6);
    expect(signTest([1, 1, 1, 1, 1])).toBeCloseTo(0.0625, 6);
    expect(signTest([1, 1, 1, -1, 0])).toBeCloseTo(0.625, 6);
    expect(signTest([0, 0])).toBe(1);
  });

  test("a paired difference is on the same cases, each case's change counted once", () => {
    const mine = ["a", "b", "c", "d", "e", "f", "g"].map((n) => row(n, 0, 2));
    const theirs = mine.map((r) => row(r.name, 2, 2));
    const all = pairedDifference(mine, theirs)!;
    expect(all).toMatchObject({ cases: 7, mean: 1, shown: true });
    expect(describeDifference(all)).toBe("+100 points on 7 cases, 95% +100 to +100");
    const few = pairedDifference(mine.slice(0, 3), theirs.slice(0, 3))!;
    expect(few.shown).toBe(false);
    expect(describeDifference(few)).toContain("no difference shown");
  });
});
