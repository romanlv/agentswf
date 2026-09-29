import { describe, expect, test } from "bun:test";
import { oracleFindings, oracleJudgement } from "../format/sanity";
import type { FindingLabel, Judgement } from "../format/scoring";
import { EXAMPLE_FINDINGS, EXAMPLE_JUDGEMENT, EXAMPLE_KEY } from "../format/testing";
import { checkJudgement } from "./check";

/** The example judgement with label `index` replaced. */
function withLabel(index: number, label: FindingLabel): Judgement {
  return {
    ...EXAMPLE_JUDGEMENT,
    labels: EXAMPLE_JUDGEMENT.labels.map((l, i) => (i === index ? label : l)),
  };
}

function problems(judgement: unknown): string[] {
  const checked = checkJudgement(judgement, EXAMPLE_FINDINGS, EXAMPLE_KEY);
  return checked.ok ? [] : checked.problems.map((p) => `${p.path}: ${p.message}`);
}

const read = [{ path: "src/app.ts", start: 1, end: 2 }];

describe("checkJudgement", () => {
  test("passes a judgement that keeps every rule, and the oracle's", () => {
    expect(problems(EXAMPLE_JUDGEMENT)).toEqual([]);
    const oracle = checkJudgement(
      oracleJudgement(EXAMPLE_KEY),
      oracleFindings(EXAMPLE_KEY),
      EXAMPLE_KEY,
    );
    expect(oracle.ok).toBe(true);
  });

  test("rejects a judgement of another shape", () => {
    expect(problems({ ...EXAMPLE_JUDGEMENT, format: "awf.review-judgement/2" })).not.toEqual([]);
    expect(
      problems(withLabel(0, { finding: 0, label: "hit", why: "w", read } as never)),
    ).not.toEqual([]);
  });

  test("every finding is labelled once", () => {
    expect(problems({ ...EXAMPLE_JUDGEMENT, labels: EXAMPLE_JUDGEMENT.labels.slice(1) })).toContain(
      "/labels: 10 labels for 11 findings; label every finding once",
    );
  });

  test("the labels go in order", () => {
    expect(problems(withLabel(5, { finding: 4, label: "noise", why: "w", read }))).toEqual([
      "/labels/5: labels finding 4; the labels go one per finding, in order",
    ]);
  });

  test("a hit names an issue in the key", () => {
    expect(
      problems(withLabel(0, { finding: 0, label: "hit", issue: "K9", why: "w", read })),
    ).toEqual(["/labels/0: K9 is not an issue in the key"]);
  });

  test("no issue is claimed twice", () => {
    expect(
      problems(withLabel(3, { finding: 3, label: "hit", issue: "K1", why: "w", read })),
    ).toEqual(["/labels/3: K1 is already hit by finding 0; this one is a duplicate"]);
  });

  test("new, wrong and noise need the lines read", () => {
    expect(problems(withLabel(5, { finding: 5, label: "noise", why: "w", read: [] }))).toEqual([
      "/labels/5: a finding labelled noise needs the lines read in the code",
    ]);
    expect(
      problems(withLabel(2, { finding: 2, label: "wrong", refutes: "r", why: "w", read: [] })),
    ).toEqual(["/labels/2: a finding labelled wrong needs the lines read in the code"]);
  });

  test("a line range read ends after it starts", () => {
    const backwards = [{ path: "src/app.ts", start: 5, end: 2 }];
    expect(
      problems(withLabel(5, { finding: 5, label: "noise", why: "w", read: backwards })),
    ).toEqual(["/labels/5: read src/app.ts ends before it starts"]);
  });

  test("a symptom names an issue in the key", () => {
    expect(
      problems(
        withLabel(2, { finding: 2, label: "wrong", refutes: "r", symptomOf: "K9", why: "w", read }),
      ),
    ).toEqual(["/labels/2: symptomOf K9 is not an issue in the key"]);
  });

  test("a duplicate names an earlier finding", () => {
    expect(
      problems(withLabel(1, { finding: 1, label: "duplicate", of: 4, why: "w", read })),
    ).toEqual(["/labels/1: a duplicate names an earlier finding, not 4"]);
  });

  test("an unsettled finding names an unconfirmed exclusion", () => {
    expect(
      problems(withLabel(7, { finding: 7, label: "unsettled", excluded: 0, why: "w", read })),
    ).toEqual(["/labels/7: exclusion 0 is not an unconfirmed one in the key"]);
    expect(
      problems(withLabel(7, { finding: 7, label: "unsettled", excluded: 5, why: "w", read })),
    ).toEqual(["/labels/7: exclusion 5 is not an unconfirmed one in the key"]);
  });
});

describe("the rules added for key growth and the panel", () => {
  test("a repeated false claim names a refuted claim in the key", () => {
    expect(
      problems(
        withLabel(2, { finding: 2, label: "wrong", refutes: "r", repeats: "R9", why: "w", read }),
      ),
    ).toEqual(["/labels/2: repeats R9, which is not a refuted claim in the key"]);
  });

  test("a finding the judges split on is unsettled without an exclusion", () => {
    expect(
      problems(withLabel(7, { finding: 7, label: "unsettled", why: "split", read: [] })),
    ).toEqual([]);
  });

  test("each vote keeps the rules: a panel vote over every finding, a tiebreak over its own", () => {
    const tiebreak = [EXAMPLE_JUDGEMENT.labels[2]!, EXAMPLE_JUDGEMENT.labels[5]!];
    const judgement: Judgement = {
      ...EXAMPLE_JUDGEMENT,
      votes: [
        { by: "a", role: "panel", labels: EXAMPLE_JUDGEMENT.labels },
        { by: "b", role: "panel", labels: EXAMPLE_JUDGEMENT.labels },
        { by: "t", role: "tiebreak", labels: tiebreak },
      ],
    };
    expect(problems(judgement)).toEqual([]);
    const short: Judgement = {
      ...judgement,
      votes: [{ by: "a", role: "panel", labels: EXAMPLE_JUDGEMENT.labels.slice(0, 3) }],
    };
    expect(problems(short)).toEqual([
      "/votes/0/labels: 3 labels for 11 findings; label every finding once",
    ]);
    const backwards: Judgement = {
      ...judgement,
      votes: [{ by: "t", role: "tiebreak", labels: tiebreak.toReversed() }],
    };
    expect(problems(backwards)).toContain(
      "/votes/0/labels/1: labels finding 2; the labels go one per finding, in order",
    );
  });

  test("a label of the wrong shape is reported as the label it names", () => {
    expect(problems(withLabel(0, { finding: 0, label: "hit", why: "w", read } as never))).toEqual([
      "/labels/0: must have required properties issue",
    ]);
    expect(problems(withLabel(0, { finding: 0, label: "maybe", why: "w", read } as never))).toEqual(
      ["/labels/0/label: must be one of hit, new, wrong, noise, duplicate, unsettled"],
    );
  });
});

test("a voter's bare unsettled fails; only the settled labels may say the judges split", () => {
  const bare: FindingLabel = { finding: 7, label: "unsettled", why: "hard", read: [] };
  const labels = EXAMPLE_JUDGEMENT.labels.map((l, i) => (i === 7 ? bare : l));
  expect(problems({ ...EXAMPLE_JUDGEMENT, labels })).toEqual([]);
  expect(problems({ ...EXAMPLE_JUDGEMENT, votes: [{ by: "a", role: "panel", labels }] })).toEqual([
    "/votes/0/labels/7: an unsettled finding names the unconfirmed claim it repeats, in excluded",
  ]);
});
