import { describe, expect, test } from "bun:test";
import type { ScoreRecord, TrialRecord } from "../format/records";
import { trialSpend } from "./outcome";

const score = (at: string, estimate: number): ScoreRecord => ({
  kind: "awf.case-score/1",
  at,
  entries: [{ grader: "judge", estimate } as ScoreRecord["entries"][number]],
});

const trial = (scores: ScoreRecord[], reused = false) => ({
  record: {
    estimate: 1,
    ...(reused ? { reused: { run: "r", column: 0, trial: 1 } } : {}),
  } as unknown as TrialRecord,
  scores,
});

const run = { started: "2026-11-19T10:00:00.000Z", finished: "2026-11-19T11:00:00.000Z" };

describe("what a run spent on a trial", () => {
  test("its own: the workflow run and the grades made while the run ran", () => {
    const graded = trial([
      score("2026-11-19T10:30:00.000Z", 0.5),
      score("2026-11-19T12:00:00.000Z", 2),
    ]);
    expect(trialSpend(graded, run)).toBe(1.5);
  });

  test("its own, graded first by a later score: that grade is not the run's", () => {
    expect(trialSpend(trial([score("2026-11-19T12:00:00.000Z", 2)]), run)).toBe(1);
  });

  test("a reused one: only the grades made while the run ran", () => {
    const reused = trial(
      [score("2026-11-18T10:00:00.000Z", 3), score("2026-11-19T10:30:00.000Z", 0.25)],
      true,
    );
    expect(trialSpend(reused, run)).toBe(0.25);
  });

  test("a run with no finish counts every grade since its start", () => {
    const open = { started: run.started };
    expect(trialSpend(trial([score("2026-11-19T12:00:00.000Z", 2)]), open)).toBe(3);
  });
});
