import { checkSchema, describeProblems } from "../../shared/validate";
import { minorOf } from "../../shared/version";
import { type CaseReport, CaseReportSchema, REPORT_KIND } from "../format/output";
import type { RunRecord } from "../format/records";
import { JUDGE_VERSION } from "../judge/version";
import { columnLabel } from "./columns";
import { type Context, envOf, tmpOf } from "./command-context";
import { type ColumnVerdict, compareColumns } from "./compare";
import type { DatasetInfo } from "./dataset";
import type { LabGrader } from "./grading";
import { agreementOf, judgeLabeled, type PersonAgreement, readLabels } from "./labels";
import { type CaseRow, newestEntries } from "./outcome";
import { agreements, poolNumbers } from "./pooled";
import { pairedDifference, ratesOf } from "./rates";
import { type RunReport, renderRun, tagRows } from "./report";
import { type CaseBar, rowsOf, unreadableRuns } from "./runs";
import { readableRuns, type StoredTrial } from "./store";
import { trialSettingsOf } from "./trial-settings";
import type { CaseWorkspace } from "./workspace";

// The report a run ends with: its rows, the other columns, compare's verdicts and the person's
// agreement.

/** `compare`'s verdict on each column but the reference; undefined when the dataset has none. */
export async function columnVerdicts(
  context: Context,
  {
    workspace,
    info,
    run,
    trials,
    bars,
  }: {
    workspace: CaseWorkspace;
    info: DatasetInfo;
    run: RunRecord;
    trials: readonly StoredTrial[];
    bars: ReadonlyMap<string, CaseBar>;
  },
): Promise<ColumnVerdict[] | undefined> {
  return compareColumns({
    run,
    trials,
    bars,
    datasetDir: info.dir,
    root: workspace.root,
    tmp: tmpOf(context),
    env: envOf(context),
    timeoutMs: trialSettingsOf(info.name, info.dataset).setupTimeoutMs,
  });
}

/**
 * The person's labels on a run's trials and how the lab agrees with them, and how many labeled
 * trials the current judge graded across the dataset's runs, for its "checked" mark.
 */
function personOf({
  workspace,
  dataset,
  trials,
  bars,
  graders,
}: {
  workspace: CaseWorkspace;
  dataset: string;
  trials: readonly StoredTrial[];
  bars: ReadonlyMap<string, CaseBar>;
  graders: readonly LabGrader[] | undefined;
}): Pick<RunReport, "person" | "judgeLabeled"> {
  const labels = readLabels(workspace.store, dataset);
  const person = agreementOf(trials, labels, (name) => bars.get(name)?.deciders);
  const judge = graders?.find((g) => g.name === "criteria");
  const agent =
    judge?.agent ??
    trials.flatMap((t) => newestEntries(t.scores)).find((e) => e.grader === "criteria" && !e.beside)
      ?.agent;
  if (!agent) return person ? { person } : {};
  const runs = [...readableRuns(workspace.store, { dataset })].map((r) => r.trials);
  return {
    ...(person ? { person } : {}),
    judgeLabeled: judgeLabeled(runs, labels, {
      ...agent,
      minor: minorOf(judge?.version ?? JUDGE_VERSION),
    }),
  };
}

/** The rows of each column but yours, from the second on. */
function otherColumns(
  store: string,
  run: RunRecord,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
): CaseRow[][] {
  return run.columns.slice(1).map((_, i) => rowsOf(store, run, trials, bars, i + 1));
}

/**
 * How a run, report or score ends: the run's rows and the other columns', the person's agreement
 * and `compare`'s verdicts, rendered, and as `--json` for an exit the caller settles.
 */
export async function runReport(
  context: Context,
  workspace: CaseWorkspace,
  args: {
    /** The dataset as it is now; undefined when it no longer reads. */
    info: DatasetInfo | undefined;
    run: RunRecord;
    trials: readonly StoredTrial[];
    bars: ReadonlyMap<string, CaseBar>;
    graders: readonly LabGrader[] | undefined;
    criteria: number;
    stale?: CaseReport["stale"];
    /** The run's plan was printed just before. */
    followsPlan?: boolean;
  },
) {
  const { info, run, trials, bars, stale } = args;
  const rows = rowsOf(workspace.store, run, trials, bars);
  const others = otherColumns(workspace.store, run, trials, bars);
  const personal = personOf({
    workspace,
    dataset: run.dataset,
    trials,
    bars,
    graders: args.graders,
  });
  const verdicts = info
    ? await columnVerdicts(context, { workspace, info, run, trials, bars })
    : undefined;
  const { text, exit } = renderRun({
    run,
    rows,
    others,
    trials: [...trials],
    criteria: args.criteria,
    ...(stale !== undefined ? { stale } : {}),
    decidersOf: (name) => bars.get(name)?.deciders,
    tagsOf: (name) => bars.get(name)?.tags ?? [],
    ungradedOf: (name) => bars.get(name)?.ungraded,
    ...(args.followsPlan ? { followsPlan: true } : {}),
    ...(verdicts ? { verdicts } : {}),
    leftOut: unreadableRuns(workspace.store).filter((id) => id < run.id),
    ...personal,
  });
  return {
    rows,
    others,
    person: personal.person,
    verdicts,
    text,
    exit,
    json: (exit: number) =>
      reportJson({
        run,
        rows,
        trials,
        exit,
        bars,
        others,
        ...(stale !== undefined ? { stale } : {}),
        ...(personal.person ? { person: personal.person } : {}),
        ...(verdicts ? { verdicts } : {}),
      }),
  };
}

/** `report --json`: a run's cases, pooled numbers and agreement, checked against its schema. */
export function reportJson(args: {
  run: RunRecord;
  rows: readonly CaseRow[];
  trials: readonly StoredTrial[];
  exit: number;
  bars: ReadonlyMap<string, CaseBar>;
  stale?: CaseReport["stale"];
  withTrials?: boolean;
  others?: readonly CaseRow[][];
  person?: PersonAgreement;
  verdicts?: readonly ColumnVerdict[];
}): CaseReport {
  const { run, rows, trials, exit, bars } = args;
  const own = trials.filter((t) => t.record.column === 0);
  const pooled = poolNumbers(own);
  const report: CaseReport = {
    kind: REPORT_KIND,
    run: run.id,
    dataset: run.dataset,
    partial: run.finished === undefined || run.broke !== undefined,
    exit,
    params: run.columns[0]!.params,
    reused: trials.filter((t) => t.record.reused).length,
    rates: ratesOf(rows),
    tags: tagRows(rows, (name) => bars.get(name)?.tags ?? []),
    cases: rows.map((row) => ({
      name: row.name,
      verdict: row.tally.verdict ?? null,
      ...(row.tally.none ? { none: row.tally.none } : {}),
      passed: row.tally.passed,
      trials: row.tally.trials,
      knownFailing: row.knownFailing,
      outcomes: row.outcomes,
      ...(row.why ? { why: row.why } : {}),
      notes: row.notes,
      history: row.history,
    })),
    numbers: Object.fromEntries(
      [...pooled.graders].map(([grader, numbers]) => [grader, Object.fromEntries(numbers)]),
    ),
    numbersLeftOut: pooled.left,
    agreement: agreements(own, (name) => bars.get(name)?.deciders),
    ...(args.person ? { labels: args.person } : {}),
    ...(args.stale !== undefined ? { stale: args.stale } : {}),
    ...(args.others && args.others.length > 0
      ? {
          columns: args.others.map((column, i) => {
            const { folder: at, params } = run.columns[i + 1]!;
            const { env, ...folder } = run.folders[at]!;
            const theirs = poolNumbers(trials.filter((t) => t.record.column === i + 1));
            const difference = pairedDifference(rows, column);
            return {
              label: columnLabel(run, i + 1),
              ...(args.verdicts?.[i] ? { compare: args.verdicts[i] } : {}),
              rates: ratesOf(column),
              ...(difference ? { difference } : {}),
              ...folder,
              params,
              envDiffers: env !== run.folders[0]!.env,
              numbers: Object.fromEntries(
                [...theirs.graders].map(([grader, numbers]) => [
                  grader,
                  Object.fromEntries(numbers),
                ]),
              ),
              numbersLeftOut: theirs.left,
              cases: column.map((row) => ({
                name: row.name,
                verdict: row.tally.verdict ?? null,
                passed: row.tally.passed,
                trials: row.tally.trials,
              })),
            };
          }),
        }
      : {}),
    ...(args.withTrials ? { trials: trials.map((t) => ({ ...t.record, scores: t.scores })) } : {}),
  };
  const checked = checkSchema(CaseReportSchema, report);
  if (!checked.ok) throw new Error(describeProblems("report --json", checked.problems));
  return report;
}
