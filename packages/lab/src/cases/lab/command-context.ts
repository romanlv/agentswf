import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type AllowanceSource, awfAllowance } from "../../shared/allowance";
import { findConfigFile } from "../../shared/config-file";
import {
  awfLogs,
  awfRunEstimate,
  processRunner,
  type Runner,
  withoutCallingSession,
} from "../../shared/runner";
import { checkSchema, describeProblems } from "../../shared/validate";
import { minorOf } from "../../shared/version";
import { type CaseReport, CaseReportSchema, REPORT_KIND } from "../format/output";
import type { RunRecord } from "../format/records";
import { JUDGE_VERSION } from "../judge/version";
import { codeGraders, graderVersions } from "./code-graders";
import { columnLabel } from "./columns";
import { type ColumnVerdict, compareColumns } from "./compare";
import { criteriaJudge } from "./criteria";
import { type CaseInfo, type DatasetInfo, graderSpecs, readCases, readDataset } from "./dataset";
import type { LabGrader } from "./grading";
import type { FolderSetup } from "./inspect";
import { agreementOf, judgeLabeled, type PersonAgreement, readLabels } from "./labels";
import { type CaseRow, newestEntries } from "./outcome";
import { agreements, poolNumbers } from "./pooled";
import { pairedDifference, ratesOf } from "./rates";
import { readRecords } from "./record-copies";
import { Refusal } from "./refusal";
import { type RunReport, renderRun, tagRows } from "./report";
import { type CaseBar, rowsOf, unreadableRuns } from "./runs";
import { awfRunsOf, readableRuns, type StoredTrial } from "./store";
import { definedOf, type TrialLab } from "./trial";
import { trialSettingsOf } from "./trial-settings";
import { workflowGraders } from "./workflow-graders";
import { type CaseWorkspace, chooseDataset, openCaseWorkspace } from "./workspace";

// What the commands share: the options and environment they run under, the workspace and dataset
// they open, the graders they grade with, and the report a run ends with.

export type CasesEnvironment = {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Runs one trial's `awf run`; absent, the folder's own `awf`, as a process. */
  runner?: Runner;
  /** `awf logs` of a trial's run, for the marker search; absent, the folder's own `awf`, unless
   * the runner is scripted. */
  logs?: TrialLab["logs"];
  /** What a run that printed no record is estimated at; absent, the folder's own `awf`, unless
   * the runner is scripted. */
  estimate?: TrialLab["estimate"];
  /** Asked before a run; absent, a run on a terminal asks the operator. */
  confirm?: (plan: string) => Promise<boolean>;
  /** The home `~/.awf/lab` is in. */
  home?: string;
  /** Where trial folders are made. */
  tmp?: string;
  /** The environment trials start from. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The checks of a folder before the first trial; absent, the real ones. */
  inspect?: (root: string, envFile: string) => Promise<FolderSetup>;
  /** `awf allowance --json`, for a loop's wait; absent, the operator's, unless the runner is scripted. */
  allowance?: AllowanceSource;
  /** Graders a test adds after `expect`, before the dataset's own. */
  graders?: readonly LabGrader[];
  now?: () => Date;
};

export type Options = {
  config?: string;
  dataset?: string;
  cases?: string[];
  /** Folders `--against` names, as given. */
  against: string[];
  /** `--param` and `--vary`, as given. */
  param: string[];
  fresh: boolean;
  /** `run --holdout`: the held-out cases alone. */
  holdout: boolean;
  clear: boolean;
  md: boolean;
  /** `score --judge {harness}/{model}`, repeatable, and `--voters`. */
  judges: string[];
  voters?: number;
  tags?: string[];
  vary: string[];
  failed: boolean;
  trials?: number;
  yes: boolean;
  case?: string;
  grader?: string;
  good: boolean;
  needsWork?: string;
  dryRun: boolean;
  budget?: number;
  json: boolean;
  help: boolean;
  program?: string;
  proposer?: string;
  rounds?: number;
  allowance?: number | "off";
  final: boolean;
  patch: boolean;
};

export type Context = {
  cwd: string;
  home: string;
  options: Options;
  environment: CasesEnvironment;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/**
 * What the lab reaches outside itself through: the runner, and the `awf logs`, run-estimate and
 * allowance readers. A scripted runner switches the real readers off: they would read runs it
 * never started. The logs reader then reads nothing, so the marker search fails closed.
 */
export function externalsOf(environment: CasesEnvironment): {
  runner: Runner;
  logs: TrialLab["logs"];
  estimate?: TrialLab["estimate"];
  allowance?: AllowanceSource;
} {
  const scripted = environment.runner !== undefined;
  const estimate = environment.estimate ?? (scripted ? undefined : awfRunEstimate);
  const allowance = environment.allowance ?? (scripted ? undefined : awfAllowance);
  return {
    runner: environment.runner ?? processRunner(),
    logs:
      environment.logs ??
      (scripted ? async () => ({ unread: "no awf logs beside a scripted runner" }) : awfLogs),
    ...(estimate ? { estimate } : {}),
    ...(allowance ? { allowance } : {}),
  };
}

/** The environment a trial, grader or helper starts from: the lab's, less the calling session. */
export const envOf = (context: Context) =>
  definedOf(withoutCallingSession(context.environment.env ?? process.env));

/** Where trial folders and the lab's other scratch folders are made. */
export const tmpOf = (context: Context) => realpathSync(context.environment.tmp ?? tmpdir());

export function workspaceOf(context: Context): CaseWorkspace {
  const config = findConfigFile(context.cwd, context.options.config);
  if (!config) {
    throw new Refusal(
      `no awf-lab.json here or above ${context.cwd}; awf-lab case new {dataset}/{case} makes one`,
    );
  }
  const workspace = openCaseWorkspace(config, context.home);
  if (workspace.records) readRecords(workspace.store, workspace.records);
  return workspace;
}

/**
 * A dataset and its cases: those not held out, or with `holdout` the held-out ones alone, so
 * nothing tuned on the rest ever sees them unasked.
 */
export function loadDataset(
  workspace: CaseWorkspace,
  name?: string,
  /** `all` for a kept run's report or score: its cases are whichever it ran. */
  holdout: boolean | "all" = false,
): { info: DatasetInfo; cases: CaseInfo[] } {
  const chosen = chooseDataset(workspace, name);
  const info = readDataset(chosen.name, chosen.dir);
  const all = readCases(info);
  const held = new Set(info.dataset.holdout ?? []);
  const unknown = [...held].filter((name) => !all.some((c) => c.name === name));
  if (unknown.length > 0) {
    throw new Refusal(`${info.name}'s holdout names no case ${unknown.join(", ")}`);
  }
  return {
    info,
    cases: holdout === "all" ? all : all.filter((c) => held.has(c.name) === holdout),
  };
}

/** Whether a case carries any of these tags. */
export const tagged = (info: CaseInfo, tags: readonly string[]) =>
  (info.key.tags ?? []).some((t) => tags.includes(t));

export async function askOperator(
  plan: string,
  stderr: (text: string) => void,
  question = "run it?",
): Promise<boolean> {
  stderr(plan);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

export function lockHeld(workspace: CaseWorkspace, heldBy: number | undefined): string {
  const file = join(workspace.labHome, "lock");
  return heldBy === undefined
    ? `${file} holds no process this lab can read: remove it once no awf-lab runs`
    : `another awf-lab run or score (process ${heldBy}) holds ${file}`;
}

/**
 * The test's graders and the dataset's own, each with its version read in your checkout before
 * the first grade: a grader that doesn't load stops the command (exit 2). Grader workflows run on
 * your checkout's `awf`, which `folder` gives when one is first needed.
 */
export async function datasetGraders(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  folder: () => Promise<FolderSetup>,
  now: () => Date,
): Promise<LabGrader[]> {
  const { environment } = context;
  const { runner } = externalsOf(environment);
  const specs = graderSpecs(info);
  const settings = trialSettingsOf(info.name, info.dataset);
  let versions = new Map<string, string>();
  if (specs.length > 0) {
    const work = mkdtempSync(join(tmpOf(context), "awf-lab-versions-"));
    try {
      versions = await graderVersions(info, {
        root: workspace.root,
        work,
        env: envOf(context),
        timeoutMs: settings.setupTimeoutMs,
      });
    } catch (error) {
      throw new Refusal(`${info.name}'s graders: ${(error as Error).message}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const runRoot = awfRunsOf(workspace.store);
  const workflows = workflowGraders(
    { dataset: info, awf: async () => (await folder()).awf, runner, runRoot, now },
    specs,
  );
  const judgeAgent = info.dataset.judgeAgent ?? workspace.judgeAgent;
  const judge = judgeAgent ? [criteriaJudge({ runner, runRoot, now }, judgeAgent)] : [];
  return [
    ...(environment.graders ?? []),
    ...codeGraders(info, workspace.root, settings.setupTimeoutMs),
    ...workflows,
    ...judge,
  ].map((g) => {
    const version = versions.get(g.name) ?? g.version;
    return version ? { ...g, version } : g;
  });
}

/** The dataset's graders, only counted, never run, so no folder is inspected. */
export function countedGraders(context: Context, workspace: CaseWorkspace, info: DatasetInfo) {
  return datasetGraders(
    context,
    workspace,
    info,
    () => Promise.reject(new Error("counting graders runs none")),
    () => new Date(),
  );
}

/** `compare`'s verdict on each column but the reference; undefined when the dataset has none. */
export async function verdictsOf(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  run: RunRecord,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
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
function personOf(
  workspace: CaseWorkspace,
  dataset: string,
  trials: readonly StoredTrial[],
  bars: ReadonlyMap<string, CaseBar>,
  graders: readonly LabGrader[] | undefined,
): Pick<RunReport, "person" | "judgeLabeled"> {
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
  },
) {
  const { info, run, trials, bars, stale } = args;
  const rows = rowsOf(workspace.store, run, trials, bars);
  const others = otherColumns(workspace.store, run, trials, bars);
  const personal = personOf(workspace, run.dataset, trials, bars, args.graders);
  const verdicts = info ? await verdictsOf(context, workspace, info, run, trials, bars) : undefined;
  const { text, exit } = renderRun({
    run,
    rows,
    others,
    trials: [...trials],
    criteria: args.criteria,
    ...(stale !== undefined ? { stale } : {}),
    decidersOf: (name) => bars.get(name)?.deciders,
    tagsOf: (name) => bars.get(name)?.tags ?? [],
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
    partial: run.finished === undefined,
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
