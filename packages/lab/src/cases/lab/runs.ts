import { criteriaOf } from "../format/key";
import type { Params, RunRecord } from "../format/records";
import { columnLike } from "./columns";
import type { CaseInfo, DatasetInfo } from "./dataset";
import { decidersOf, type LabGrader } from "./grading";
import { type CaseRow, caseRow, trialOutcome } from "./outcome";
import {
  readableRuns,
  readRunRecord,
  readTrials,
  runIds,
  type StoredTrial,
  UnreadableRecord,
} from "./store";
import { type CaseVerdict, caseVerdict } from "./verdict";

/**
 * A case's bar, whether it is known failing, and whose grades decide its trials: all from its key
 * and the dataset as they are now.
 */
export type CaseBar = {
  pass: string;
  knownFailing: boolean;
  deciders?: ReadonlySet<string>;
  tags: readonly string[];
};

/** `graders`: every grader that may decide besides `expect`, the dataset's and a test's. */
export function barsOf(
  dataset: DatasetInfo | undefined,
  cases: readonly CaseInfo[],
  graders?: readonly Pick<LabGrader, "name" | "onDemand">[],
): Map<string, CaseBar> {
  return new Map(
    cases.map((c) => [
      c.name,
      {
        pass: c.key.pass ?? dataset?.dataset.pass ?? "all",
        knownFailing: c.key["known-failing"] === true,
        tags: c.key.tags ?? [],
        ...(graders ? { deciders: decidersOf(c.key, graders) } : {}),
      },
    ]),
  );
}

const asked = (run: RunRecord, name: string) => run.asked.find((a) => a.case === name)?.trials ?? 0;

/** Each case's verdict in one column of a run. */
function verdictsOf(
  run: RunRecord,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
  column: number,
): Map<string, CaseVerdict | undefined> {
  const verdicts = new Map<string, CaseVerdict | undefined>();
  for (const { case: name } of run.asked) {
    const own = trials.filter((t) => t.record.case === name && t.record.column === column);
    // A run that only reused trials adds nothing new: its verdict was given where they ran.
    if (own.length === 0 || own.every((t) => t.record.reused)) continue;
    const deciders = bars.get(name)?.deciders;
    const outcomes = own.map((t) => trialOutcome(t.record, t.scores, deciders).outcome);
    verdicts.set(
      name,
      caseVerdict(outcomes, asked(run, name), bars.get(name)?.pass ?? "all").verdict,
    );
  }
  return verdicts;
}

/**
 * Earlier runs of the same dataset with a column of this checkout under these parameters, oldest
 * first, each with that column's verdicts. A run whose records this lab can't read (written
 * before a `/0` record changed shape) is left out; `runs` names it.
 */
function earlier(
  store: string,
  dataset: string,
  root: string,
  params: Params,
  /** Runs before this id; every run when absent. */
  before: string | undefined,
  bars: ReadonlyMap<string, CaseBar>,
): { run: RunRecord; verdicts: Map<string, CaseVerdict | undefined> }[] {
  return [...readableRuns(store, { dataset })].flatMap(({ run, trials }) => {
    if (before !== undefined && run.id >= before) return [];
    const column = columnLike(run, root, params);
    if (column === undefined) return [];
    return [{ run, verdicts: verdictsOf(run, trials, bars, column) }];
  });
}

/** The runs whose records this lab can't read, which history leaves out. */
export function unreadableRuns(store: string): string[] {
  return runIds(store).filter((n) => {
    try {
      readRunRecord(store, n);
      readTrials(store, n);
      return false;
    } catch (error) {
      if (error instanceof UnreadableRecord) return true;
      throw error;
    }
  });
}

/** Up to five earlier verdicts of each case in the run's reference column, newest last. */
export function historyOf(
  store: string,
  run: RunRecord,
  bars: ReadonlyMap<string, CaseBar>,
): Map<string, CaseVerdict[]> {
  const history = new Map<string, CaseVerdict[]>();
  const { path } = run.folders[0]!;
  const { params } = run.columns[0]!;
  for (const { verdicts } of earlier(store, run.dataset, path, params, run.id, bars)) {
    for (const [name, verdict] of verdicts) {
      if (!verdict) continue;
      history.set(name, [...(history.get(name) ?? []), verdict].slice(-5));
    }
  }
  return history;
}

/**
 * `--failed`: the cases whose newest verdict in the reference column (your checkout under these
 * parameters) is failed, flaky or unclear, each with the trials of the run that gave it.
 */
export function failedCases(
  store: string,
  dataset: string,
  root: string,
  params: Params,
  bars: ReadonlyMap<string, CaseBar>,
): Map<string, number> {
  const newest = new Map<string, { verdict: CaseVerdict | undefined; trials: number }>();
  const runs = earlier(store, dataset, root, params, undefined, bars);
  for (const { run, verdicts } of runs) {
    for (const [name, verdict] of verdicts) newest.set(name, { verdict, trials: asked(run, name) });
  }
  return new Map(
    [...newest]
      .filter(([, v]) => v.verdict === "failed" || v.verdict === "flaky" || v.verdict === "unclear")
      .map(([name, v]) => [name, v.trials]),
  );
}

/** A run's rows for a column, the reference column by default, which alone has history. */
export function rowsOf(
  store: string,
  run: RunRecord,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
  column = 0,
): CaseRow[] {
  const history = column === 0 ? historyOf(store, run, bars) : new Map<string, CaseVerdict[]>();
  return run.asked.map(({ case: name, trials: count }) => {
    const bar = bars.get(name) ?? { pass: "all", knownFailing: false, tags: [] };
    const own = trials.filter((t) => t.record.case === name && t.record.column === column);
    return caseRow(
      name,
      own,
      count,
      bar.pass,
      bar.knownFailing,
      history.get(name) ?? [],
      bar.deciders,
    );
  });
}

export function criteriaCount(cases: readonly CaseInfo[], names: readonly string[]): number {
  return cases
    .filter((c) => names.includes(c.name))
    .reduce((n, c) => n + criteriaOf(c.key).length, 0);
}
