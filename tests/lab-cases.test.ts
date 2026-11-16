import { describe, expect, test } from "bun:test";
import type { TrialRecord } from "../packages/lab/src/cases/format/records";
import { type Evidence, FAKE, problems } from "./lab-cases";

const trial = (over: Partial<TrialRecord> = {}) =>
  ({
    facts: { room: FAKE, outcome: "answered", calls: 1 },
    refused: [],
    ...over,
  }) as TrialRecord;

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  exitCode: 0,
  out: "",
  err: "",
  trial: trial(),
  verdict: "passed",
  ...over,
});

describe("lab-cases eval checks", () => {
  test("a passed trial on the mocked room is clean", () => {
    expect(problems(evidence())).toEqual([]);
  });

  test("the real module's room, a second call or a refusal is a problem", () => {
    expect(
      problems(evidence({ trial: trial({ facts: { room: null, outcome: "failed", calls: 0 } }) })),
    ).toEqual([`room null, not the mocked ${FAKE}`, "find called 0 times"]);
    expect(problems(evidence({ trial: trial({ facts: { room: FAKE, calls: 2 } }) }))).toEqual([
      "find called 2 times",
    ]);
    expect(
      problems(
        evidence({
          trial: trial({
            refused: [{ what: "directory.find", by: "function", phase: "body", message: "x" }],
          }),
        }),
      ),
    ).toEqual(["refused: directory.find"]);
  });

  test("a failed run, no verdict or no trial is a problem", () => {
    expect(problems(evidence({ exitCode: 1, verdict: "failed" }))).toEqual([
      "awf-lab exited 1",
      "expect: failed",
    ]);
    expect(problems(evidence({ trial: undefined, exitCode: 4 }))).toEqual([
      "awf-lab exited 4",
      "no trial record",
    ]);
  });
});
