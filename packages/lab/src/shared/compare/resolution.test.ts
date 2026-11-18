import { expect, test } from "bun:test";
import { resolution, tieReach, varianceOf } from "./resolution";
import type { CaseScore, MetricSpec } from "./types";

const score: MetricSpec = { name: "score", direction: "higher", onVariantFailure: 0 };
const trial = (id: string, n: number, value: number | null): CaseScore => ({
  case: id,
  trial: n,
  outcome: "scored",
  metrics: { score: value },
});

// Experiment 1 used z, 0.08–0.11 at 33 cases and 0.16–0.23 at 8; the paired t test the comparison
// runs needs more at few cases, which a simulation of that test confirmed (80% power at the high end).
test("experiment 1's measured variance resolves ~0.08–0.12 at 33 cases, ~0.19–0.27 at 8", () => {
  const variance = { between: 0.19 ** 2, within: 0.13 ** 2 };
  const [low, high] = resolution(variance, 33, 2)!;
  expect(low).toBeCloseTo(0.083, 3);
  expect(high).toBeCloseTo(0.116, 3);
  const [few, most] = resolution(variance, 8, 2)!;
  expect(few).toBeCloseTo(0.189, 3);
  expect(most).toBeCloseTo(0.265, 3);
  // More trials only shrink the within-case part.
  expect(resolution(variance, 33, 3)![1]).toBeLessThan(high);
  expect(resolution(variance, 33, 3)![1]).toBeGreaterThan(0.09);
});

// Task 7's run: a tie within the default ±0.05 is out of reach even at the dataset's end.
test("at experiment 1's variance a tie shows within ~±0.06–0.08 at best at 33 cases", () => {
  const variance = { between: 0.19 ** 2, within: 0.13 ** 2 };
  const [low, high] = tieReach(variance, 33, 2)!;
  expect(low).toBeCloseTo(0.058, 3);
  expect(high).toBeCloseTo(0.082, 3);
  expect(tieReach({ between: null, within: 0.01 }, 33, 2)).toBeNull();
});

test("variance components: within pooled from repeated cases, between net of trial noise", () => {
  // Case means 0.2, 0.4, 0.6 with trials ±0.1 around them.
  const scores = [
    trial("a", 1, 0.1),
    trial("a", 2, 0.3),
    trial("b", 1, 0.3),
    trial("b", 2, 0.5),
    trial("c", 1, 0.5),
    trial("c", 2, 0.7),
  ];
  const v = varianceOf(scores, score);
  expect(v.cases).toBe(3);
  expect(v.trials).toBe(2);
  expect(v.mean).toBeCloseTo(0.4, 10);
  expect(v.within).toBeCloseTo(0.02, 10);
  // The means' variance is 0.04; each mean of two carries 0.02 / 2 of trial noise.
  expect(v.between).toBeCloseTo(0.03, 10);
});

test("one trial a case: no within-case variance, so no resolution; a failed trial scores its failure value", () => {
  const v = varianceOf(
    [trial("a", 1, 0.2), trial("b", 1, 0.6), { ...trial("c", 1, null), outcome: "variant-failed" }],
    score,
  );
  expect(v.within).toBeNull();
  expect(v.cases).toBe(3);
  expect(resolution(v, 10, 1)).toBeNull();
  // Identical cases: no between-case variance, never below 0.
  expect(
    varianceOf([trial("a", 1, 0.5), trial("a", 2, 0.5), trial("b", 1, 0.5)], score).between,
  ).toBe(0);
});
