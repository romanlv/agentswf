import { expect, test } from "bun:test";
import { resolution, varianceOf } from "./resolution";
import type { CaseScore, MetricSpec } from "./types";

const score: MetricSpec = { name: "score", direction: "higher", onVariantFailure: 0 };
const trial = (id: string, n: number, value: number | null): CaseScore => ({
  case: id,
  trial: n,
  outcome: "scored",
  metrics: { score: value },
});

test("experiment 1's measured variance resolves what it reported: 0.08–0.11 at 33 cases, 0.16–0.23 at 8", () => {
  const variance = { between: 0.19 ** 2, within: 0.13 ** 2 };
  const [low, high] = resolution(variance, 33, 2)!;
  expect(low).toBeCloseTo(0.08, 2);
  expect(high).toBeCloseTo(0.112, 2);
  const [few, most] = resolution(variance, 8, 2)!;
  expect(few).toBeCloseTo(0.163, 2);
  expect(most).toBeCloseTo(0.228, 2);
  // More trials only shrink the within-case part.
  expect(resolution(variance, 33, 3)![1]).toBeLessThan(high);
  expect(resolution(variance, 33, 3)![1]).toBeGreaterThan(0.09);
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
