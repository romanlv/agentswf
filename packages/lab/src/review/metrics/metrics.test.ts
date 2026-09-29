import { describe, expect, test } from "bun:test";
import {
  NOP_FINDINGS,
  NOP_SCORER_RESULT,
  oracleFindings,
  oracleScorerResult,
} from "../format/sanity";
import type { FindingLabel } from "../format/scoring";
import {
  EXAMPLE_FINDINGS,
  EXAMPLE_FINDINGS_RECORD,
  EXAMPLE_KEY,
  EXAMPLE_LABELS,
  EXAMPLE_SCORE_RECORD,
} from "../format/testing";
import { agreement, count, type Judged, metrics, phases, spendOf, sum } from "./metrics";

const example: Judged = {
  fixture: "app-1",
  findings: EXAMPLE_FINDINGS,
  labels: EXAMPLE_LABELS,
  key: EXAMPLE_KEY,
};
const oracle: Judged = {
  fixture: "app-1",
  findings: oracleFindings(EXAMPLE_KEY),
  labels: oracleScorerResult(EXAMPLE_KEY).labels,
  key: EXAMPLE_KEY,
};
const nop: Judged = {
  fixture: "app-1",
  findings: NOP_FINDINGS,
  labels: NOP_SCORER_RESULT.labels,
  key: EXAMPLE_KEY,
};

describe("the sanity bounds", () => {
  test("the oracle scores recall 1 at every severity, with nothing wrong or noisy", () => {
    const m = metrics(count(oracle));
    expect(m.recall).toEqual({ "must-fix": 1, "should-fix": 1, "could-fix": 1, nit: 1 });
    expect(m.weightedRecall).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.wrong).toBe(0);
    expect(m.noise).toBe(0);
    expect(m.missed).toEqual([]);
    expect(m.counts.context).toEqual({ total: 1, hit: 1 });
  });

  test("nop scores 0 with no findings", () => {
    const m = metrics(count(nop));
    expect(m.recall).toEqual({ "must-fix": 0, "should-fix": 0, "could-fix": 0, nit: 0 });
    expect(m.weightedRecall).toBe(0);
    expect(m.distinct).toBe(0);
    expect(m.precision).toBeNull();
    expect(m.words).toBe(0);
    expect(m.missed.map((missed) => missed.issue)).toEqual(["K1", "K2", "K7"]);
  });
});

describe("a fixture with every label gives the numbers the table defines", () => {
  const m = metrics(count(example));

  test("recall by severity counts the issues the MR caused; context apart", () => {
    expect(m.recall).toEqual({ "must-fix": 2 / 3, "should-fix": 0, "could-fix": 0, nit: 1 });
    // 3·2 hit of 3·3 + 2·1 + 1·1: nits apart.
    expect(m.weightedRecall).toBe(6 / 12);
    expect(m.counts.context).toEqual({ total: 1, hit: 1 });
    expect(m.missed).toEqual([{ fixture: "app-1", issue: "K7", mechanism: "K7: what goes wrong" }]);
  });

  test("distinct findings leave out duplicates and unsettled ones", () => {
    expect(m.counts.findings).toBe(11);
    expect(m.distinct).toBe(8);
    expect(m.precision).toBe(6 / 8);
    expect(m.wrong).toBe(1 / 8);
    expect(m.noise).toBe(1 / 8);
    expect(m.nits).toBe(2 / 8);
    expect(m.words).toBe(33);
  });

  test("the splits: category and where each issue came from", () => {
    expect(m.counts.byCategory.correctness).toEqual({ total: 2, hit: 1 });
    expect(m.counts.byCategory.performance).toEqual({ total: 0, hit: 0 });
    expect(m.counts.bySource).toEqual({
      comment: { total: 4, hit: 2 },
      commit: { total: 2, hit: 1 },
      run: { total: 1, hit: 0 },
    });
  });

  test("a category filter neither rewards nor penalises a true finding outside it", () => {
    const filtered = metrics(count(example, { categories: ["correctness"] }));
    expect(filtered.recall["must-fix"]).toBe(1 / 2);
    expect(filtered.recall.nit).toBeNull();
    expect(filtered.counts.context).toEqual({ total: 0, hit: 0 });
    // The hits on K2, K5 and K6 and the new docs-style nit drop out; the wrong claim and noise stay.
    expect(filtered.counts.findings).toBe(7);
    expect(filtered.distinct).toBe(4);
    expect(filtered.precision).toBe(2 / 4);
    expect(filtered.wrong).toBe(1 / 4);
    expect(filtered.words).toBe(33);
  });
});

test("fixtures are summed before dividing", () => {
  const both = metrics(sum([count(example), count(oracle)]));
  expect(both.fixtures).toBe(2);
  expect(both.distinct).toBe(15);
  expect(both.precision).toBe(13 / 15);
  expect(both.recall["must-fix"]).toBe(5 / 6);
  expect(both.missed.map((missed) => missed.issue)).toEqual(["K7"]);
});

describe("agreement", () => {
  const hit = (finding: number, issue: string): FindingLabel => ({
    finding,
    label: "hit",
    issue,
    why: "w",
    read: [],
  });
  const plain = (finding: number, label: "noise" | "wrong"): FindingLabel =>
    label === "noise"
      ? { finding, label, why: "w", read: [] }
      : { finding, label, refutes: "r", why: "w", read: [] };

  test("is Cohen's κ, a hit agreeing only on the same issue", () => {
    expect(agreement(EXAMPLE_LABELS, EXAMPLE_LABELS)).toBe(1);
    expect(agreement([hit(0, "K1"), plain(1, "noise")], [hit(0, "K1"), plain(1, "wrong")])).toBe(
      1 / 3,
    );
    expect(agreement([hit(0, "K1"), hit(1, "K2")], [hit(0, "K2"), hit(1, "K1")])).toBe(-1);
  });

  test("is undefined for different findings or none, and total when chance is", () => {
    expect(agreement([hit(0, "K1")], [])).toBeNull();
    expect(agreement([], [])).toBeNull();
    expect(agreement([plain(0, "noise")], [plain(0, "noise")])).toBe(1);
    expect(agreement([plain(0, "noise")], [plain(0, "wrong")])).toBe(0);
  });
});

describe("cost and time per phase", () => {
  test("sums time and priced spend, the reviewer's and the judge's apart", () => {
    const review = EXAMPLE_FINDINGS_RECORD;
    const unpriced = { ...review, run: { ...review.run, estimate: undefined, complete: false } };
    expect(phases([review, review], [EXAMPLE_SCORE_RECORD])).toEqual({
      restoreMs: 2_400,
      review: { runs: 2, ms: 120_000, estimate: 1, complete: true },
      judge: { runs: 1, ms: 60_000, estimate: 0.5, complete: true },
    });
    expect(phases([review, unpriced], []).review).toEqual({
      runs: 2,
      ms: 120_000,
      estimate: null,
      complete: false,
    });
  });

  test("with nothing run, nothing was spent", () => {
    expect(spendOf([undefined])).toEqual({ runs: 0, ms: 0, estimate: 0, complete: true });
  });
});

test("an empty category filter is a mistake, not a filter that counts nothing", () => {
  expect(() => count(example, { categories: [] })).toThrow("names at least one");
});
