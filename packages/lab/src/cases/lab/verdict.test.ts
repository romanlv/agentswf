import { describe, expect, test } from "bun:test";
import type { Outcome } from "../format/records";
import { gradeExpect } from "./expect";
import { type CaseTally, caseVerdict, exitCodeOf, isBroken, needOf, outcomeOf } from "./verdict";

const base = {
  leaked: false,
  workflowErred: false,
  stopped: false,
  verdicts: [],
  numbers: false,
  notGraded: false,
} as const;

describe("outcomeOf", () => {
  test("takes the first that applies: leaked, errored, stopped, failed, …, passed", () => {
    expect(outcomeOf({ ...base, leaked: true, errored: { by: "dataset" } })).toBe("leaked");
    expect(outcomeOf({ ...base, errored: { by: "grading" }, verdicts: ["failed"] })).toBe(
      "errored",
    );
    expect(outcomeOf({ ...base, stopped: true })).toBe("stopped");
    expect(outcomeOf({ ...base, workflowErred: true, verdicts: ["passed"] })).toBe("failed");
    expect(outcomeOf({ ...base, verdicts: ["passed", "undecided"] })).toBe("undecided");
    expect(outcomeOf({ ...base, verdicts: ["passed"] })).toBe("passed");
    expect(outcomeOf({ ...base, numbers: true })).toBe("graded by numbers");
    expect(outcomeOf({ ...base, notGraded: true })).toBe("not graded");
  });
});

const tally = (outcomes: Outcome[], trials = outcomes.length, pass = "all") =>
  caseVerdict(outcomes, trials, pass);

describe("caseVerdict", () => {
  test("three trials at the default bar", () => {
    expect(tally(["passed", "passed", "passed"]).verdict).toBe("passed");
    expect(tally(["passed", "passed", "failed"]).verdict).toBe("flaky");
    expect(tally(["passed", "failed", "failed"]).verdict).toBe("failed");
    expect(tally(["failed", "failed", "failed"]).verdict).toBe("failed");
    expect(tally(["passed", "passed", "undecided"]).verdict).toBe("unclear");
    expect(tally(["passed", "passed", "undecided"]).note).toBe("1 undecided");
  });

  test("a stopped trial counts as failed; errored trials leave a case unclear", () => {
    expect(tally(["stopped", "stopped", "passed"]).verdict).toBe("failed");
    expect(tally(["errored", "errored", "errored"]).verdict).toBe("unclear");
  });

  test("an unclear note leaves out the one trial's outcome the row already names", () => {
    expect(caseVerdict(["passed", "passed", "errored"], 4, "all", "errored").note).toBe(
      "1 not run",
    );
    expect(caseVerdict(["errored", "errored", "leaked"], 3, "all", "errored").note).toBe(
      "2 errored, 1 leaked",
    );
  });

  test("a 2/3 bar passes with one failed trial, and asks every trial at one or two", () => {
    expect(tally(["passed", "passed", "failed"], 3, "2/3").verdict).toBe("passed");
    expect(needOf("2/3", 1)).toBe(1);
    expect(needOf("2/3", 2)).toBe(2);
    expect(tally(["passed"], 1, "2/3").note).toContain("asks every one");
  });

  test("no verdict when no trial was graded, or only by numbers", () => {
    expect(tally(["not graded", "not graded"]).none).toBe("not graded");
    expect(tally(["graded by numbers", "not graded"]).none).toBe("graded by numbers");
  });
});

const row = (
  tally: Partial<CaseTally>,
  extra: { knownFailing?: boolean; brokenTrial?: boolean } = {},
) => ({
  tally: { passed: 0, failed: 0, trials: 1, need: 1, ...tally },
  knownFailing: extra.knownFailing ?? false,
  brokenTrial: extra.brokenTrial ?? false,
});

describe("exitCodeOf", () => {
  test("0 when all passed, 1 on a failed case, 3 on flaky or unclear", () => {
    expect(exitCodeOf({ cases: [row({ verdict: "passed" })], partial: false })).toBe(0);
    expect(
      exitCodeOf({
        cases: [row({ verdict: "failed" }), row({ verdict: "passed" })],
        partial: false,
      }),
    ).toBe(1);
    expect(exitCodeOf({ cases: [row({ verdict: "flaky" })], partial: false })).toBe(3);
    expect(exitCodeOf({ cases: [row({ verdict: "unclear" })], partial: false })).toBe(3);
  });

  test("5 when a trial errored by the dataset or grading, or leaked, unless a case failed", () => {
    expect(
      exitCodeOf({ cases: [row({ verdict: "unclear" }, { brokenTrial: true })], partial: false }),
    ).toBe(5);
    expect(
      exitCodeOf({
        cases: [row({ verdict: "failed" }), row({ verdict: "unclear" }, { brokenTrial: true })],
        partial: false,
      }),
    ).toBe(1);
  });

  test("a known-failing case never changes it by its verdict, but its broken trial still gives 5", () => {
    const known = { knownFailing: true };
    expect(
      exitCodeOf({
        cases: [row({ verdict: "failed" }, known), row({ verdict: "passed" })],
        partial: false,
      }),
    ).toBe(0);
    expect(
      exitCodeOf({
        cases: [
          row({ verdict: "unclear" }, { ...known, brokenTrial: true }),
          row({ verdict: "passed" }),
        ],
        partial: false,
      }),
    ).toBe(5);
  });

  test("3 for a partial run, or when no case was graded; numbers count as graded", () => {
    expect(exitCodeOf({ cases: [row({ verdict: "passed" })], partial: true })).toBe(3);
    expect(exitCodeOf({ cases: [row({ none: "not graded" })], partial: false })).toBe(3);
    expect(exitCodeOf({ cases: [row({ none: "graded by numbers" })], partial: false })).toBe(0);
  });

  test("isBroken: dataset, grading and leaked; never the provider's", () => {
    expect(isBroken("errored", { by: "dataset" })).toBe(true);
    expect(isBroken("errored", { by: "provider" })).toBe(false);
    expect(isBroken("leaked")).toBe(true);
  });
});

describe("gradeExpect", () => {
  test("passes on exact values and fails on others, null against a value included", () => {
    expect(gradeExpect({ relevant: true }, { relevant: true, extra: "x" })).toEqual({
      verdict: "passed",
      reasons: [],
    });
    const failed = gradeExpect({ reply: null, short: false }, { reply: "hi", short: null });
    expect("verdict" in failed && failed.verdict).toBe("failed");
  });

  test("a missing fact or a type mismatch is the dataset's", () => {
    expect(gradeExpect({ relevant: true }, {})).toMatchObject({ errored: "facts-missing" });
    expect(gradeExpect({ relevant: true }, { relevant: "true" })).toMatchObject({
      errored: "fact-type",
    });
  });
});
