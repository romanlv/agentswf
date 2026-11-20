import { describe, expect, test } from "bun:test";
import { better, type ComparedTrial, defineComparison } from "./compare";

const trial = (
  name: string,
  passed: boolean,
  extra: Partial<ComparedTrial> = {},
): ComparedTrial => ({
  case: name,
  trial: 1,
  passed,
  workflowFailed: false,
  numbers: {},
  cost: 0.01,
  seconds: 5,
  ...extra,
});
const cases = Array.from({ length: 10 }, (_, i) => `case-${i}`);

describe("what better means for a dataset", () => {
  test("better.paired on passed: a column that passes every case the reference fails is better", () => {
    const compare = better.paired({ primary: "passed" });
    const verdict = compare.compare({
      reference: cases.map((c) => trial(c, false)),
      column: cases.map((c) => trial(c, true)),
      planned: cases.length,
    });
    expect(verdict.verdict).toBe("better");
    expect(verdict.stop).toBe(true);
    const reverse = compare.compare({
      reference: cases.map((c) => trial(c, true)),
      column: cases.map((c) => trial(c, false)),
      planned: cases.length,
    });
    expect(reverse.verdict).toBe("worse");
  });

  test("a guard on cost: cheaper is never worse on cost, a costlier column is", () => {
    const compare = better.paired({
      primary: "passed",
      guards: [{ metric: "cost", margin: 0.001 }],
    });
    const verdict = compare.compare({
      reference: cases.map((c) => trial(c, false, { cost: 0.01 })),
      column: cases.map((c) => trial(c, true, { cost: 0.5 })),
      planned: cases.length,
    });
    expect(verdict.verdict).toBe("worse");
  });

  test("a grader's number, with what a failed workflow scores", () => {
    const compare = better.paired({
      primary: "match.recall",
      metrics: { "match.recall": { onFailure: 0 } },
    });
    const verdict = compare.compare({
      reference: cases.map((c) => trial(c, true, { numbers: { "match.recall": 0.4 } })),
      column: cases.map((c) => trial(c, false, { workflowFailed: true })),
      planned: cases.length,
    });
    expect(verdict.verdict).toBe("worse");
    const missing = better.paired({ primary: "match.recall" }).compare({
      reference: cases.map((c) => trial(c, true, { numbers: { "match.recall": 0.4 } })),
      column: cases.map((c) => trial(c, false, { workflowFailed: true })),
      planned: cases.length,
    });
    expect(missing.verdict).not.toBe("worse");
  });

  test("better.mean on a number of your own, and defineComparison checks its version", () => {
    const compare = better.mean((t) => (t.passed ? 1 : 0) - t.seconds / 100);
    const verdict = compare.compare({
      reference: cases.map((c) => trial(c, true, { seconds: 50 })),
      column: cases.map((c) => trial(c, true, { seconds: 5 })),
      planned: cases.length,
    });
    expect(verdict.verdict).toBe("better");
    expect(compare.version).toBe("1.0.0");
    expect(() => defineComparison({ version: "1.0", compare: () => ({}) as never })).toThrow(
      "defineComparison",
    );
  });
});
