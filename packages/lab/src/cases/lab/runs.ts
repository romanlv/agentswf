import { criteriaOf } from "../format/key";
import type { RunRecord } from "../format/records";
import type { CaseInfo, DatasetInfo } from "./dataset";
import { type CaseRow, caseRow, trialOutcome } from "./outcome";
import { readRunRecord, readTrials, runNumbers, type StoredTrial } from "./store";
import { type CaseVerdict, caseVerdict } from "./verdict";

/** A case's bar and whether it is known failing, from its key as it is now. */
export type CaseBar = { pass: string; knownFailing: boolean };

export function barsOf(
  dataset: DatasetInfo | undefined,
  cases: readonly CaseInfo[],
): Map<string, CaseBar> {
  return new Map(
    cases.map((c) => [
      c.name,
      {
        pass: c.key.pass ?? dataset?.dataset.pass ?? "all",
        knownFailing: c.key["known-failing"] === true,
      },
    ]),
  );
}

const asked = (run: RunRecord, name: string) => run.asked.find((a) => a.case === name)?.trials ?? 0;

/** Each case's verdict in a run, your checkout's column. */
function verdictsOf(
  run: RunRecord,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
): Map<string, CaseVerdict | undefined> {
  const verdicts = new Map<string, CaseVerdict | undefined>();
  for (const { case: name } of run.asked) {
    const own = trials.filter((t) => t.record.case === name && t.record.column === 0);
    if (own.length === 0) continue;
    const outcomes = own.map((t) => trialOutcome(t.record, t.scores).outcome);
    verdicts.set(
      name,
      caseVerdict(outcomes, asked(run, name), bars.get(name)?.pass ?? "all").verdict,
    );
  }
  return verdicts;
}

/** Earlier runs of the same dataset and checkout, oldest first, each with its verdicts. */
function earlier(
  store: string,
  dataset: string,
  root: string,
  before: number,
  bars: ReadonlyMap<string, CaseBar>,
): { run: RunRecord; verdicts: Map<string, CaseVerdict | undefined> }[] {
  return runNumbers(store)
    .filter((n) => n < before)
    .flatMap((n) => {
      const run = readRunRecord(store, n);
      if (!run || run.dataset !== dataset || run.folders[0]?.path !== root) return [];
      return [{ run, verdicts: verdictsOf(run, readTrials(store, n), bars) }];
    });
}

/** Up to five earlier verdicts of each case, newest last. */
export function historyOf(
  store: string,
  run: RunRecord,
  bars: ReadonlyMap<string, CaseBar>,
): Map<string, CaseVerdict[]> {
  const history = new Map<string, CaseVerdict[]>();
  for (const { verdicts } of earlier(store, run.dataset, run.folders[0]!.path, run.number, bars)) {
    for (const [name, verdict] of verdicts) {
      if (!verdict) continue;
      history.set(name, [...(history.get(name) ?? []), verdict].slice(-5));
    }
  }
  return history;
}

/**
 * `--failed`: the cases whose newest verdict in your checkout's column is failed, flaky or
 * unclear, each with the trials of the run that gave it.
 */
export function failedCases(
  store: string,
  dataset: string,
  root: string,
  bars: ReadonlyMap<string, CaseBar>,
): Map<string, number> {
  const newest = new Map<string, { verdict: CaseVerdict | undefined; trials: number }>();
  for (const { run, verdicts } of earlier(store, dataset, root, Number.POSITIVE_INFINITY, bars)) {
    for (const [name, verdict] of verdicts) newest.set(name, { verdict, trials: asked(run, name) });
  }
  return new Map(
    [...newest]
      .filter(([, v]) => v.verdict === "failed" || v.verdict === "flaky" || v.verdict === "unclear")
      .map(([name, v]) => [name, v.trials]),
  );
}

/** A run's rows, your checkout's column, with history. */
export function rowsOf(
  store: string,
  run: RunRecord,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
): CaseRow[] {
  const history = historyOf(store, run, bars);
  return run.asked.map(({ case: name, trials: count }) => {
    const bar = bars.get(name) ?? { pass: "all", knownFailing: false };
    const own = trials.filter((t) => t.record.case === name && t.record.column === 0);
    return caseRow(name, own, count, bar.pass, bar.knownFailing, history.get(name) ?? []);
  });
}

export function criteriaCount(cases: readonly CaseInfo[], names: readonly string[]): number {
  return cases
    .filter((c) => names.includes(c.name))
    .reduce((n, c) => n + criteriaOf(c.key).length, 0);
}
