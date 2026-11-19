import type { CaseReport } from "../format/output";
import {
  type Context,
  chooseRun,
  countedGraders,
  loadDataset,
  reportJson,
  runReport,
  tmpOf,
  workspaceOf,
} from "./command-context";
import type { CaseInfo, DatasetInfo } from "./dataset";
import type { LabGrader } from "./grading";
import { readLabels } from "./labels";
import { Refusal } from "./refusal";
import { markdownOf, renderCase } from "./report";
import { barsOf, criteriaCount } from "./runs";
import { regradePlan } from "./score";
import { awfRunsOf, readTrials, type StoredTrial } from "./store";
import type { CaseWorkspace } from "./workspace";

// `report`: a kept run again, as text, `--json` or `--md`, or one case of it in full.

/** How many grades `score` would make again, or why that couldn't be told. */
function staleGrades(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  cases: readonly CaseInfo[],
  trials: readonly StoredTrial[],
  graders: readonly LabGrader[],
): number | { unread: string } {
  try {
    const plan = regradePlan({
      trials,
      store: workspace.store,
      info,
      cases,
      graders,
      tmp: tmpOf(context),
    });
    return [...plan.counts.values()].reduce((a, b) => a + b, 0);
  } catch (error) {
    return { unread: (error as Error).message };
  }
}

export async function report(context: Context, names: readonly string[]): Promise<number> {
  const workspace = workspaceOf(context);
  if (context.options.json && context.options.md) {
    throw new Refusal("report takes --json or --md, not both");
  }
  if (context.options.case && context.options.md) {
    throw new Refusal("report --case prints one case as text or --json; --md is the whole run's");
  }
  const run = chooseRun(workspace, names, "report");
  let info: DatasetInfo | undefined;
  let cases: CaseInfo[] = [];
  try {
    ({ info, cases } = loadDataset(workspace, run.dataset, "all"));
  } catch (error) {
    // A dataset since removed or broken: its run still reads, at the default bar, every grade
    // deciding.
    const unread =
      error instanceof Refusal || typeof (error as { code?: unknown }).code === "string";
    if (!unread) throw error;
    context.stderr(
      `awf-lab: ${run.dataset} doesn't read (${(error as Error).message}): the report uses the default bars, every grade deciding`,
    );
  }
  let graders: LabGrader[] | undefined;
  let stale: CaseReport["stale"];
  const trials = readTrials(workspace.store, run.id);
  if (info) {
    try {
      graders = await countedGraders(context, workspace, info);
      stale = staleGrades(context, workspace, info, cases, trials, graders);
    } catch (error) {
      stale = { unread: (error as Error).message };
    }
  }
  const bars = barsOf(info, cases, graders);
  const report = await runReport(context, workspace, {
    info,
    run,
    trials,
    bars,
    graders,
    criteria: criteriaCount(
      cases,
      run.asked.map((a) => a.case),
    ),
    ...(stale !== undefined ? { stale } : {}),
  });
  const { rows, others, verdicts, exit } = report;
  if (context.options.case) {
    const row = rows.find((r) => r.name === context.options.case);
    if (!row) {
      throw new Refusal(
        `run ${run.id} has no case ${context.options.case}; its cases: ${rows.map((r) => r.name).join(", ")}`,
      );
    }
    const own = trials.filter((t) => t.record.case === row.name);
    const runRoot = awfRunsOf(workspace.store);
    if (context.options.json) {
      context.stdout(
        JSON.stringify(
          reportJson({
            run,
            rows: [row],
            trials: own,
            exit,
            bars,
            withTrials: true,
            ...(report.person ? { person: report.person } : {}),
          }),
          null,
          2,
        ),
      );
      return exit;
    }
    context.stdout(
      renderCase({
        run,
        row,
        trials: own,
        logsCommand: (trialId) => {
          const trial = own.find((t) => t.record.runId === trialId)?.record;
          const bin = trial?.awf.bin ?? "awf";
          const folder =
            run.folders[run.columns[trial?.column ?? 0]?.folder ?? 0] ?? run.folders[0]!;
          return `(cd ${folder.path} && bun --no-env-file ${bin} logs ${trialId} --run-root ${runRoot})`;
        },
        deciders: bars.get(row.name)?.deciders,
        others: others.map((column) => column.find((r) => r.name === row.name)),
        labels: readLabels(workspace.store, run.dataset),
      }),
    );
  } else if (context.options.md) {
    context.stdout(
      markdownOf({
        run,
        rows,
        others,
        trials,
        criteria: 0,
        ...(verdicts ? { verdicts } : {}),
      }),
    );
  } else if (context.options.json) {
    context.stdout(JSON.stringify(report.json(exit), null, 2));
  } else context.stdout(report.text);
  return exit;
}
