import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AllowanceSource } from "../../shared/allowance";
import { findConfigFile } from "../../shared/config-file";
import {
  awfLogs,
  awfRunEstimate,
  processRunner,
  type Runner,
  withoutCallingSession,
} from "../../shared/runner";
import { checkSchema, describeProblems } from "../../shared/validate";
import {
  type CaseReport,
  CaseReportSchema,
  REPORT_KIND,
  SCORED_KIND,
  type Scored,
  ScoredSchema,
} from "../format/output";
import { LABEL_KIND, type Mark as LabelMark, RUN_KIND, type RunRecord } from "../format/records";
import { JUDGE_VERSION } from "../judge/version";
import {
  CAPTURE_FILE,
  capturedKey,
  checkCaptured,
  findRealRun,
  findTrial,
  freeName,
  type Mark,
  readRealRun,
  writeCase,
} from "./capture";
import { codeGraders, graderVersions, runHelper } from "./code-graders";
import { columnLabel, columnsOf, combinations, type ParamPlan, readParams } from "./columns";
import { type ColumnVerdict, compareColumns } from "./compare";
import { criteriaJudge } from "./criteria";
import {
  type CaseInfo,
  type DatasetInfo,
  ENV_FILE,
  fileDigest,
  folderDigest,
  graderSpecs,
  readCases,
  readDataset,
} from "./dataset";
import { buildCase, clearStale } from "./folders";
import { gitState, gitTop } from "./git";
import { decidersOf, type LabGrader } from "./grading";
import { checkEnvFile, type FolderSetup, inspectFolder } from "./inspect";
import { agreementOf, appendLabel, judgeLabeled, type PersonAgreement, readLabels } from "./labels";
import { loopCommand } from "./loop-command";
import { type CaseRow, newestEntries, trialOutcome } from "./outcome";
import { agreements, poolNumbers } from "./pooled";
import { pairedDifference, ratesOf } from "./rates";
import { readRecords, writeLabels, writeRecords } from "./record-copies";
import { Refusal } from "./refusal";
import {
  describeFolder,
  markdownOf,
  median,
  plural,
  type RunReport,
  renderCase,
  renderRun,
  seconds,
  tagRows,
} from "./report";
import { refuseRetiredCommand, refuseRetiredFlag } from "./retired";
import {
  caseDigests,
  codeDigest,
  REUSE_DAYS,
  reusableTrials,
  reuseKey,
  reuseTrial,
  trialShaping,
} from "./reuse";
import { barsOf, type CaseBar, criteriaCount, failedCases, rowsOf, unreadableRuns } from "./runs";
import { newCase } from "./scaffold";
import { describePlan, planScore, runScore, type ScoreDone } from "./score";
import {
  awfRunsOf,
  claimRun,
  clearStaleTrialFiles,
  RUN_ID,
  readRunRecord,
  readTrials,
  runIds,
  type StoredTrial,
  takeLock,
  UnreadableRecord,
  writeRun,
  writeTrial,
} from "./store";
import { runTrial, type TrialDone, type TrialLab } from "./trial";
import { trialSettingsOf } from "./trial-settings";
import { workflowGraders } from "./workflow-graders";
import {
  type CaseWorkspace,
  chooseDataset,
  codeFolderOf,
  inside,
  openCaseWorkspace,
} from "./workspace";

export const CASES_USAGE = `usage: awf-lab [--config {file}] {command} …

  case new {dataset}/{case}   a case folder and its key's marker; the first time, also
                              awf-lab.json, the dataset's dataset.json and a stub env.ts
  run [--dataset {name}] [--cases {a,b}] [--tags {a,b}] [--failed] [--dry-run] [--budget {usd}] [--trials {n}] [--against {folder}]
      [--param {name}={value}] [--vary {name}={a,b}] [--fresh] [--yes]
                              the workflow, as it is in your checkout, on each case, each trial
                              in a throwaway folder, graded against its key
  report [{run}] [--case {name}] [--json | --md]
                              the last run again, or the run named by its id or last 4 characters
  score [{run}] [--grader {name} | --judge {harness}/{model} [--voters {n}]] [--tags {a,b}] [--yes] [--dry-run] [--budget {usd}] [--json]
                              grade the last run, or the one named, again without running a trial: each
                              grader whose key or version changed, or that errored
  capture {run id} (--good | --needs-work {note}) [--dataset {name}]
                              a case from a past run: a trial's, from its case, or a real one,
                              through the dataset's capture.ts; its key a draft to finish
  label {run id} (--good | --needs-work {note} | --clear)
                              the person's verdict on a trial, by its workflow run's id (report
                              --case shows them); the report gives the lab's agreement with it
  loop {name} --budget {usd} [--program {file}] [--proposer {harness/model}] [--rounds {n}]
       [--trials {n}] [--cases {a,b}] [--param …] [--allowance {pct|off}] [--dataset {name}]
                              a proposer changes a copy of the code from the tuning cases'
                              feedback, the copy runs against the incumbent case by case until
                              the dataset's compare stops it, and it is kept only when better; the
                              first run names its program and starts from your checkout; again,
                              it resumes
  loop {name} --final [--budget {usd}]
                              the kept code against the start on the held-out cases, once
  loop {name} --patch         the kept code against the start, as a patch
  runs                        the runs kept, newest first

  --dataset {name}  the dataset: a folder beside awf-lab.json holding a dataset.json; with one,
                    never named
  --cases {a,b}     only these cases
  --failed          only the cases whose newest verdict was failed, flaky or unclear, each with
                    that run's trials unless --trials says
  --trials {n}      trials a case; 1 unless told
  --against {folder}
                    also run the cases on the code in another checkout of the project, as a
                    column beside yours; repeatable. Its env.ts and code run; its cases, keys
                    and graders are never read
  --fresh           run every trial anew; without it, a trial kept from an earlier run stands in
                    when nothing that shaped it changed (the code, env.ts, the parameters, the
                    case, the trial settings), within the dataset's reuseDays, 14 by default
  --tags {a,b}      only the cases whose key lists one of these tags; on run and score
  --holdout         run the cases dataset.json holds out, alone: every other command leaves them
                    out, so a final check runs once on cases nothing was tuned on
  --param {name}={value}
                    a parameter for every trial, which env.ts reads as c.params; repeatable
  --vary {name}={a,b}
                    a column for each value, each folder; repeatable, every combination run.
                    The reference column is your checkout under each --vary's first value: the
                    exit code, history and --failed are its
  --yes             no question before a run or a score
  --grader {name}   score with this grader alone, one marked onDemand included
  --judge {harness}/{model}
                    score's criteria again with another judge, repeatable, beside the one that
                    decides: the report gives each judge's agreement with your labels and its
                    cost, and only judgeAgent's grades are in the verdict
  --voters {n}      the --judge's voters per criterion, odd; 3 by default
  --dry-run         print the plan of run or score, and run or grade nothing
  --budget {usd}    run stops starting trials, and score before a grader workflow, once their
                    estimates reach it: exit 3
  --program {file}  a loop's steering, the operator's, read by its proposer each try
  --proposer {harness/model}
                    the loop's proposer; claude/claude-sonnet-5-5 unless told
  --rounds {n}      the loop's tries this time; 1 unless told
  --allowance {pct|off}
                    a loop waits while a plan window its agents draw on is this far used; 90
                    unless told
  --json            the report, or score's plan and report, as JSON
  --md              the report as Markdown, to paste into a pull request or an issue

exit: 0 every case that must pass passed, 1 a case that must pass failed, 2 refused before any
trial, 3 a case flaky or unclear, a partial run, or nothing graded, 4 the lab broke, 5 a trial
errored by the dataset or by grading, or leaked`;

export type CasesEnvironment = {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Runs one trial's `awf run`; absent, the folder's own `awf`, as a process. */
  runner?: Runner;
  /** `awf logs` of a trial's run, for the marker search; absent, the folder's own `awf`. A test
   * that scripts the runner gives this too. */
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

/** The lab broke during a run: exit 4. */
class LabBroke extends Error {}

function parse(argv: readonly string[]): { command?: string; names: string[]; options: Options } {
  const options: Options = {
    failed: false,
    yes: false,
    dryRun: false,
    json: false,
    help: false,
    against: [],
    param: [],
    vary: [],
    fresh: false,
    holdout: false,
    clear: false,
    md: false,
    judges: [],
    good: false,
    final: false,
    patch: false,
  };
  const positional: string[] = [];
  const rest = [...argv];
  const value = (flag: string) => {
    const next = rest.shift();
    if (next === undefined || next.startsWith("--")) throw new Refusal(`${flag} needs a value`);
    return next;
  };
  while (rest.length > 0) {
    const arg = rest.shift()!;
    switch (arg) {
      case "--config":
        options.config = value(arg);
        break;
      case "--dataset":
        options.dataset = value(arg);
        break;
      case "--cases":
        options.cases = value(arg)
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        break;
      case "--failed":
        options.failed = true;
        break;
      case "--trials": {
        const text = value(arg);
        if (!/^[1-9][0-9]*$/.test(text)) throw new Refusal("--trials is a whole number from 1");
        options.trials = Number(text);
        break;
      }
      case "--against":
        options.against.push(value(arg));
        break;
      case "--tags":
        options.tags = value(arg)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case "--judge":
        options.judges.push(value(arg));
        break;
      case "--voters": {
        const text = value(arg);
        if (!/^[13579]$/.test(text)) throw new Refusal("--voters is odd, from 1 to 9");
        options.voters = Number(text);
        break;
      }
      case "--md":
        options.md = true;
        break;
      case "--holdout":
        options.holdout = true;
        break;
      case "--clear":
        options.clear = true;
        break;
      case "--fresh":
        options.fresh = true;
        break;
      case "--param":
        options.param.push(value(arg));
        break;
      case "--vary":
        options.vary.push(value(arg));
        break;
      case "--case":
        options.case = value(arg);
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--good":
        options.good = true;
        break;
      case "--needs-work":
        options.needsWork = value(arg);
        break;
      case "--grader":
        options.grader = value(arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--budget": {
        const text = value(arg);
        const usd = Number(text);
        if (!/^[0-9]+(\.[0-9]+)?$/.test(text) || !(usd > 0)) {
          throw new Refusal("--budget is US dollars, more than 0, such as 5 or 2.50");
        }
        options.budget = usd;
        break;
      }
      case "--program":
        options.program = value(arg);
        break;
      case "--proposer":
        options.proposer = value(arg);
        break;
      case "--rounds": {
        const text = value(arg);
        if (!/^[1-9][0-9]*$/.test(text)) throw new Refusal("--rounds is a whole number from 1");
        options.rounds = Number(text);
        break;
      }
      case "--allowance": {
        const text = value(arg);
        if (text === "off") options.allowance = "off";
        else if (/^[0-9]+$/.test(text) && Number(text) >= 1 && Number(text) <= 100) {
          options.allowance = Number(text);
        } else throw new Refusal("--allowance is a percent from 1 to 100, or off");
        break;
      }
      case "--final":
        options.final = true;
        break;
      case "--patch":
        options.patch = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          refuseRetiredFlag(arg);
          throw new Refusal(`unknown option ${arg}`);
        }
        positional.push(arg);
    }
  }
  const [command, ...names] = positional;
  return { ...(command ? { command } : {}), names, options };
}

export type Context = {
  cwd: string;
  home: string;
  options: Options;
  environment: CasesEnvironment;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

function workspaceOf(context: Context): CaseWorkspace {
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

/** The case kind's command line: `case new`, `run`, `report` and `runs`. */
export async function runCases(
  argv: readonly string[],
  environment: CasesEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr = environment.stderr ?? ((text) => void process.stderr.write(`${text}\n`));
  try {
    const { command, names, options } = parse(argv);
    if (options.help || !command) {
      stdout(CASES_USAGE);
      return options.help ? 0 : 2;
    }
    if (options.allowance !== undefined && command !== "loop") {
      throw new Refusal("--allowance is the loop's: loop {name} --allowance {percent}");
    }
    const context: Context = {
      cwd: environment.cwd ?? process.cwd(),
      home: environment.home ?? homedir(),
      options,
      environment,
      stdout,
      stderr,
    };
    switch (command) {
      case "case":
        return caseCommand(context, names);
      case "run":
        return await run(context);
      case "report":
        return await report(context, names);
      case "score":
        return await score(context, names);
      case "capture":
        return await captureCommand(context, names);
      case "runs":
        return runs(context);
      case "label":
        return label(context, names);
      case "loop":
        return await loopCommand(context, names, {
          run,
          verdictsOf,
          workspaceOf,
          loadDataset,
          countedGraders,
        });
      default:
        refuseRetiredCommand(command);
        throw new Refusal(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof Refusal) {
      stderr(`awf-lab: ${error.message}`);
      return 2;
    }
    stderr(`awf-lab: ${(error as Error).message}`);
    return 4;
  }
}

function caseCommand(context: Context, names: readonly string[]): number {
  const [verb, address, ...extra] = names;
  if (verb !== "new" || !address || extra.length > 0)
    throw new Refusal("awf-lab case new {dataset}/{case}");
  const config = findConfigFile(context.cwd, context.options.config);
  const evals = config ? join(config, "..") : join(gitTop(context.cwd) ?? context.cwd, "evals");
  const made = newCase(evals, address);
  for (const file of made.written) context.stdout(`wrote ${relative(context.cwd, file) || file}`);
  context.stdout(`case ${relative(context.cwd, made.caseDir)}: write its key.md and files/`);
  return 0;
}

/**
 * A dataset and its cases: those not held out, or with `holdout` the held-out ones alone, so
 * nothing tuned on the rest ever sees them unasked.
 */
function loadDataset(
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

async function askOperator(
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

/** Earlier trials of these cases: their median time and cost, times the count. */
function estimate(
  store: string,
  dataset: string,
  names: readonly string[],
  count: number,
): string | undefined {
  const ms: number[] = [];
  const cost: number[] = [];
  const grading: number[] = [];
  for (const id of runIds(store)) {
    let trials: StoredTrial[];
    try {
      if (readRunRecord(store, id)?.dataset !== dataset) continue;
      trials = readTrials(store, id);
    } catch (error) {
      if (error instanceof UnreadableRecord) continue; // `runs` names it
      throw error;
    }
    for (const { record: trial, scores } of trials) {
      if (!names.includes(trial.case) || !trial.runId || trial.reused) continue;
      if (trialOutcome(trial, scores).outcome === "errored") continue;
      // The grading the trial was given as it ran, its first score: a judge can cost far more
      // than the workflow it judges.
      const graded = scores[0]?.entries ?? [];
      ms.push(trial.ms + graded.reduce((sum, e) => sum + (e.ms ?? 0), 0));
      if (trial.estimate !== undefined) cost.push(trial.estimate);
      grading.push(graded.reduce((sum, e) => sum + (e.estimate ?? 0), 0));
    }
  }
  const time = median(ms);
  if (time === undefined) return undefined;
  const each = median(cost);
  const grades = median(grading) ?? 0;
  const price =
    each === undefined
      ? grades > 0
        ? `, grading est. $${(grades * count).toFixed(2)}, the workflow unpriced`
        : ""
      : `, est. $${((each + grades) * count).toFixed(2)}${grades > 0 ? `, grading $${(grades * count).toFixed(2)} of it` : ""}`;
  return `from earlier trials: about ${seconds(time * count)}${price}`;
}

/**
 * What a loop asks of `run` beyond its options: the code folders, the reference first, in place of
 * your checkout and `--against`; the cases in this order; each case's trials in every column before
 * the next case; and after each case whether to stop, from the trials so far.
 */
export type RunGiven = {
  folders?: readonly string[];
  order?: readonly string[];
  stop?: (run: RunRecord, trials: readonly StoredTrial[]) => Promise<boolean>;
  /** Told the run's id once it has one. */
  started?: (id: string) => void;
  /** Off, the report is not printed: the loop prints its own line. */
  report?: boolean;
};

async function run(context: Context, given: RunGiven = {}): Promise<number> {
  const { options, environment, stderr } = context;
  const workspace = workspaceOf(context);
  const { info, cases } = loadDataset(workspace, options.dataset, options.holdout);
  if (options.holdout && cases.length === 0) {
    throw new Refusal(`${info.name} holds out no case: name them in dataset.json's holdout`);
  }
  const now = environment.now ?? (() => new Date());
  let inspected: Promise<FolderSetup> | undefined;
  const folderOf = () =>
    (inspected ??= (environment.inspect ?? inspectFolder)(workspace.root, checkEnvFile(info.dir)));
  const graders = await datasetGraders(context, workspace, info, folderOf, now);
  const bars = barsOf(info, cases, graders);
  const paramPlan = readParams(options.param, options.vary);
  const combos = combinations(paramPlan);
  const byName = new Map(cases.map((c) => [c.name, c]));
  for (const name of options.cases ?? []) {
    if (!byName.has(name)) {
      throw new Refusal(
        `no case ${name} in ${info.name}; known: ${cases.map((c) => c.name).join(", ")}`,
      );
    }
  }
  let selected = options.cases ? cases.filter((c) => options.cases!.includes(c.name)) : cases;
  if (given.order) {
    const known = new Map(cases.map((c) => [c.name, c]));
    selected = given.order.flatMap((name) => known.get(name) ?? []);
  }
  if (options.tags) selected = selected.filter((c) => tagged(c, options.tags!));
  const failed = options.failed
    ? failedCases(workspace.store, info.name, workspace.root, combos[0]!, bars)
    : undefined;
  if (failed) selected = selected.filter((c) => failed.has(c.name));
  if (selected.length === 0) {
    context.stdout(
      options.failed
        ? "nothing to run: no case's newest verdict is failed, flaky or unclear"
        : `no cases in ${info.dir}; awf-lab case new ${info.name}/{case} makes one`,
    );
    return options.failed ? 0 : 2;
  }
  const trialsOf = (name: string) => options.trials ?? failed?.get(name) ?? 1;

  const envFile = checkEnvFile(info.dir);
  const criteria = criteriaCount(
    selected,
    selected.map((c) => c.name),
  );
  if (criteria > 0 && !info.dataset.judgeAgent && !workspace.judgeAgent) {
    throw new Refusal(
      `keys in ${info.name} have criteria: name a judgeAgent ({ "harness", "model" }) in awf-lab.json or dataset.json`,
    );
  }
  const codeFolders: CodeFolder[] = [];
  if (given.folders) {
    for (const dir of given.folders) {
      codeFolders.push(await againstFolder(context, workspace, info, dir, codeFolders));
    }
  } else {
    codeFolders.push({ folder: await folderOf(), envFile, state: gitState(workspace.root) });
    for (const dir of options.against) {
      codeFolders.push(await againstFolder(context, workspace, info, dir, codeFolders));
    }
  }
  const columns = columnsOf(codeFolders.length, combos);

  // Trials that ran before on what shapes a trial now, kept within reuseDays, stand in for new ones.
  // --failed asks for new evidence on what failed: the trials that failed are never its answer.
  const days = options.fresh || options.failed ? 0 : (info.dataset.reuseDays ?? REUSE_DAYS);
  const codes = codeFolders.map((c) =>
    days > 0 ? codeDigest(c.folder.root, workspace) : undefined,
  );
  const settings = trialShaping(info.dataset, workspace.hide);
  const inputs = caseDigests(info.dir, selected, realpathSync(environment.tmp ?? tmpdir()));
  const keyOf = (n: number, input: string) => {
    const { folder, params } = columns[n]!;
    const code = codes[folder];
    const awf = codeFolders[folder]!.folder.version;
    return code ? reuseKey({ code, params, input, settings, awf }) : undefined;
  };
  const stored = days > 0 ? reusableTrials(workspace.store, info.name, now(), days) : new Map();
  const reusing = new Map<string, StoredTrial[]>();
  const slot = (name: string, n: number) => `${name}\0${n}`;
  // One workflow run stands for one trial of one column: two columns that shape trials alike,
  // such as a clone at the same commit, each get trials of their own, or the pair is no check.
  const taken = new Set<string>();
  for (const c of selected) {
    for (const n of columns.keys()) {
      const key = keyOf(n, inputs.get(c.name)!);
      const found = key
        ? (stored.get(key) ?? []).filter(
            (t: StoredTrial) => t.record.case === c.name && !taken.has(t.record.runId!),
          )
        : [];
      const chosen = found.slice(0, trialsOf(c.name));
      for (const t of chosen) taken.add(t.record.runId!);
      if (chosen.length > 0) reusing.set(slot(c.name, n), chosen);
    }
  }
  const reused = [...reusing.values()].reduce((sum, list) => sum + list.length, 0);
  const tmp = realpathSync(environment.tmp ?? tmpdir());
  const regrade =
    reused > 0
      ? planScore({
          trials: [...reusing.values()].flat(),
          store: workspace.store,
          datasetDir: info.dir,
          cases,
          graders: graders.filter((g) => !g.onDemand),
          decidersOf: (c) => decidersOf(c.key, graders),
          expect: true,
          tmp,
        })
      : undefined;
  const reusedIn = (name: string, n: number) => reusing.get(slot(name, n))?.length ?? 0;

  const total = selected.reduce((n, c) => n + trialsOf(c.name), 0);
  const counts = new Set(selected.map((c) => trialsOf(c.name)));
  const plan = [
    `${info.name} · ${plural(selected.length, "case")} · ${counts.size === 1 ? `${plural([...counts][0]!, "trial")} each` : plural(total, "trial")}`,
    ...codeFolders.map(
      (c, i) =>
        `${i === 0 ? "code" : `against ${i}`}: ${describeFolder({ path: i === 0 ? undefined : c.folder.root, ...c.state })} · agentswf ${c.folder.version}`,
    ),
    ...paramLines(paramPlan, columns.length),
    ...(reused > 0
      ? [
          `reuses ${reused} of ${plural(total * columns.length, "trial")}: nothing that shaped them changed; --fresh runs new ones`,
        ]
      : []),
    ...(regrade && regrade.items.length > 0
      ? [
          `grades ${plural(regrade.items.length, "reused trial")} again, a key or grader changed${regrade.estimate !== undefined ? `: est. ${dollars(regrade.estimate)}${regrade.upTo !== undefined && regrade.upTo > regrade.estimate ? `, up to ${dollars(regrade.upTo)}` : ""}` : ""}`,
        ]
      : []),
    ...[
      estimate(
        workspace.store,
        info.name,
        selected.map((c) => c.name),
        total * columns.length - reused,
      ),
    ].filter((line): line is string => line !== undefined),
  ].join("\n");
  if (options.dryRun) {
    context.stdout(plan);
    return 0;
  }
  const withBudget =
    options.budget !== undefined
      ? `${plan}\nstops starting trials once their estimates reach ${dollars(options.budget)}`
      : plan;
  const confirm =
    environment.confirm ??
    (process.stdin.isTTY && !options.yes ? (text: string) => askOperator(text, stderr) : undefined);
  if (confirm && !options.yes) {
    if (!(await confirm(withBudget))) {
      stderr("declined; nothing run");
      return 2;
    }
  } else stderr(withBudget);

  const lock = takeLock(workspace.labHome);
  if ("heldBy" in lock) throw new Refusal(lockHeld(workspace, lock.heldBy));
  let record: RunRecord | undefined;
  try {
    const id = claimRun(workspace.store, now());
    record = {
      kind: RUN_KIND,
      id,
      dataset: info.name,
      folders: codeFolders.map((c) => ({
        path: c.folder.root,
        ...c.state,
        env: fileDigest(c.envFile),
      })),
      columns,
      asked: selected.map((c) => ({ case: c.name, trials: trialsOf(c.name) })),
      started: now().toISOString(),
    };
    writeRun(workspace.store, record);
    given.started?.(id);
    clearStale(tmp);
    clearStaleTrialFiles(workspace.labHome);
    const unrecorded = environment.estimate ?? (environment.runner ? undefined : awfRunEstimate);
    const lab: TrialLab = {
      workspace,
      dataset: info,
      envFile,
      run: id,
      runner: environment.runner ?? processRunner(),
      logs: environment.logs ?? awfLogs,
      ...(unrecorded ? { estimate: unrecorded } : {}),
      tmp,
      env: environment.env ?? process.env,
      graders,
      now,
    };
    const shown = (done: TrialDone) =>
      progress(stderr, record!, done, bars.get(done.record.case)?.deciders);
    const trialIn = (n: number, info: CaseInfo, trial: number) => {
      const column = columns[n]!;
      const code = codeFolders[column.folder]!;
      return runTrial(lab, code.folder, info, n, trial, code.envFile, column.params, (input) =>
        keyOf(n, input),
      );
    };
    // Trial t of every case, then t + 1; under a loop's `stop`, a case's every trial first.
    const passes: { cases: CaseInfo[]; trial: number }[] = [];
    const most = Math.max(...selected.map((c) => trialsOf(c.name)));
    // What this run's own trials and their grading are estimated at, for --budget.
    let estimated = 0;
    const over = () => options.budget !== undefined && estimated >= options.budget;
    const counted = (done: TrialDone) => {
      estimated +=
        (done.record.estimate ?? 0) +
        (done.score?.entries ?? []).reduce((sum, e) => sum + (e.estimate ?? 0), 0);
    };
    try {
      for (const [at, list] of reusing) {
        const n = Number(at.split("\0")[1]);
        for (const [i, from] of list.entries()) reuseTrial(workspace.store, id, from, n, i + 1);
      }
      if (regrade && regrade.items.length > 0) {
        const done = await gradeReused(
          context,
          workspace,
          info,
          cases,
          graders,
          id,
          tmp,
          now,
          options.budget,
        );
        estimated += done.estimate;
        if (done.stopped) record = { ...record, stopped: "budget" };
      }
      if (given.stop) {
        for (const c of selected) {
          for (let trial = 1; trial <= trialsOf(c.name); trial++)
            passes.push({ cases: [c], trial });
        }
      } else {
        for (let trial = 1; trial <= most; trial++) {
          passes.push({ cases: selected.filter((c) => trialsOf(c.name) >= trial), trial });
        }
      }
      for (const [p, { cases: inPass, trial }] of passes.entries()) {
        if (record.stopped) break;
        const again: [CaseInfo, number][] = [];
        for (const info of inPass) {
          for (const n of columns.keys()) {
            if (trial <= reusedIn(info.name, n)) continue;
            if (over()) {
              record = { ...record, stopped: "budget" };
              continue;
            }
            const done = await trialIn(n, info, trial);
            counted(done);
            shown(done);
            if (done.record.errored?.by === "provider") again.push([info, n]);
          }
        }
        for (const [info, n] of again) {
          if (over()) {
            record = { ...record, stopped: "budget" };
            break;
          }
          const done = await trialIn(n, info, trial);
          counted(done);
          const retried = { ...done.record, retried: true };
          writeTrial(done.dir, retried);
          shown({ ...done, record: retried });
        }
        // A case is whole once its last trial ran: the comparison may stop the rest.
        const next = passes[p + 1];
        const whole = !next || next.cases[0] !== inPass[0];
        if (given.stop && whole && !record.stopped) {
          if (await given.stop(record, readTrials(workspace.store, id))) {
            record = { ...record, stopped: "compare" };
          }
        }
      }
    } catch (error) {
      record = { ...record, broke: (error as Error).message };
      writeRun(workspace.store, record);
      throw new LabBroke(`the lab broke during run ${id}: ${(error as Error).message}`);
    }
    record = { ...record, finished: now().toISOString() };
    writeRun(workspace.store, record);
  } catch (error) {
    if (error instanceof LabBroke) {
      stderr(`awf-lab: ${error.message}`);
      return 4;
    }
    throw error;
  } finally {
    if (record && workspace.records) writeRecords(workspace.store, workspace.records, record.id);
    lock.release();
  }
  const trials = readTrials(workspace.store, record.id);
  const rows = rowsOf(workspace.store, record, trials, bars);
  const verdicts = await verdictsOf(context, workspace, info, record, trials, bars);
  const { text, exit } = renderRun({
    run: record,
    rows,
    others: otherColumns(workspace.store, record, trials, bars),
    trials,
    criteria,
    decidersOf: (name) => bars.get(name)?.deciders,
    tagsOf: (name) => bars.get(name)?.tags ?? [],
    ...(verdicts ? { verdicts } : {}),
    leftOut: unreadableRuns(workspace.store).filter((id) => id < record.id),
    ...personOf(workspace, record.dataset, trials, bars, graders),
  });
  // A budget stop leaves trials unrun: 3, unless the report already exits worse.
  const stoppedExit = record.stopped === "budget" && exit === 0 ? 3 : exit;
  if (given.report === false) return stoppedExit;
  if (options.json) {
    const { person } = personOf(workspace, record.dataset, trials, bars, graders);
    const json = reportJson({
      run: record,
      rows,
      trials,
      exit: stoppedExit,
      bars,
      others: otherColumns(workspace.store, record, trials, bars),
      ...(person ? { person } : {}),
      ...(verdicts ? { verdicts } : {}),
    });
    context.stdout(JSON.stringify(json, null, 2));
  } else context.stdout(text);
  return stoppedExit;
}

/**
 * Grades the trials a run reused where a key or grader changed since they were graded, as `score`
 * would, with no question: the run's plan asked.
 */
async function gradeReused(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  cases: readonly CaseInfo[],
  graders: readonly LabGrader[],
  run: string,
  tmp: string,
  now: () => Date,
  budget: number | undefined,
): Promise<ScoreDone> {
  const trials = readTrials(workspace.store, run).filter((t) => t.record.reused);
  const plan = planScore({
    trials,
    store: workspace.store,
    datasetDir: info.dir,
    cases,
    graders: graders.filter((g) => !g.onDemand),
    decidersOf: (c) => decidersOf(c.key, graders),
    expect: true,
    tmp,
  });
  if (plan.items.length === 0) {
    return { graded: new Map(), errored: new Map(), estimate: 0, stopped: false };
  }
  context.stderr(
    `grading ${plural(plan.items.length, "reused trial")} again: a key or grader changed`,
  );
  return runScore({
    plan,
    tmp,
    run,
    store: workspace.store,
    env: definedOf(withoutCallingSession(context.environment.env ?? process.env)),
    ...(budget !== undefined ? { budget } : {}),
    now,
    progress: context.stderr,
  });
}

/** Dollars as a plan says them: cents, or four places below a cent. */
const dollars = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;

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
  const version = judge?.version ?? JUDGE_VERSION;
  if (!agent) return person ? { person } : {};
  const runs = runIds(workspace.store).flatMap((id) => {
    try {
      return readRunRecord(workspace.store, id)?.dataset === dataset
        ? [readTrials(workspace.store, id)]
        : [];
    } catch (error) {
      if (error instanceof UnreadableRecord) return [];
      throw error;
    }
  });
  const minor = version.split(".").slice(0, 2).join(".");
  return {
    ...(person ? { person } : {}),
    judgeLabeled: judgeLabeled(runs, labels, { ...agent, minor }),
  };
}

/** `compare`'s verdict on each column but the reference; undefined when the dataset has none. */
async function verdictsOf(
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
    tmp: realpathSync(context.environment.tmp ?? tmpdir()),
    env: definedOf(withoutCallingSession(context.environment.env ?? process.env)),
    timeoutMs: trialSettingsOf(info.name, info.dataset).setupTimeoutMs,
  });
}

/** Whether a case carries any of these tags. */
const tagged = (info: CaseInfo, tags: readonly string[]) =>
  (info.key.tags ?? []).some((t) => tags.includes(t));

/** A folder of code, its `env.ts` and its git state. */
type CodeFolder = { folder: FolderSetup; envFile: string; state: ReturnType<typeof gitState> };

/** The plan's lines for parameters: those every column shares, and what varies. */
function paramLines(plan: ParamPlan, columns: number): string[] {
  const fixed = Object.entries(plan.fixed).map(([name, value]) => `${name}=${value}`);
  return [
    ...(fixed.length > 0 ? [`params: ${fixed.join(" ")}`] : []),
    ...(plan.varied.length > 0
      ? [
          `vary: ${plan.varied.map(([name, values]) => `${name}=${values.join(",")}`).join(" ")} · ${plural(columns, "column")}, the first value of each the reference`,
        ]
      : []),
  ];
}

/**
 * A folder `--against` names: another checkout of the project, holding the dataset at the same
 * path as yours. Only its `env.ts`, its code and its `awf` are used; its cases, keys and graders
 * are never read. Checked as your checkout is before the first trial.
 */
async function againstFolder(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  given: string,
  taken: readonly CodeFolder[],
): Promise<CodeFolder> {
  const at = resolve(context.cwd, given);
  if (!existsSync(at)) throw new Refusal(`--against ${given}: no such folder`);
  const dir = realpathSync(at);
  const top = workspace.repository ?? workspace.root;
  const datasetDir = join(dir, relative(top, info.dir));
  const evals = join(dir, relative(top, workspace.evals));
  if (!existsSync(join(datasetDir, ENV_FILE))) {
    throw new Refusal(
      `--against ${given}: no ${relative(top, join(info.dir, ENV_FILE))} there; it names another checkout of this project, holding the dataset at the same path`,
    );
  }
  if (dir === workspace.root || dir === workspace.repository) {
    throw new Refusal(`--against ${given}: that is your checkout`);
  }
  const root = codeFolderOf(dirname(evals));
  // Its own install, never one above it: a worktree inside another checkout would run that one.
  if (!inside(dir, root) || !existsSync(join(root, "node_modules", "agentswf"))) {
    throw new Refusal(
      `--against ${given}: no agentswf installed in it; run bun install there (its code runs on its own install)`,
    );
  }
  if (taken.some((c) => c.folder.root === root)) {
    throw new Refusal(`--against ${given}: ${root} is named twice`);
  }
  let envFile: string;
  try {
    envFile = checkEnvFile(datasetDir);
  } catch (error) {
    throw new Refusal(`--against ${given}: ${(error as Error).message}`);
  }
  const folder = await (context.environment.inspect ?? inspectFolder)(root, envFile);
  return { folder, envFile, state: gitState(root) };
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

function progress(
  stderr: (text: string) => void,
  run: RunRecord,
  done: TrialDone,
  deciders: ReadonlySet<string> | undefined,
): void {
  const view = trialOutcome(done.record, done.score ? [done.score] : [], deciders);
  stderr(
    `  ${done.record.case} ${done.record.trial}${done.record.column > 0 ? ` (${columnLabel(run, done.record.column)})` : ""}: ${view.outcome}${done.record.retried ? " (tried again)" : ""} · ${seconds(done.record.ms)}`,
  );
}

/**
 * The test's graders and the dataset's own, each with its version read in your checkout before
 * the first grade: a grader that doesn't load stops the command (exit 2). Grader workflows run on
 * your checkout's `awf`, which `folder` gives when one is first needed.
 */
/** The dataset's graders, only counted, never run, so no folder is inspected. */
function countedGraders(context: Context, workspace: CaseWorkspace, info: DatasetInfo) {
  return datasetGraders(
    context,
    workspace,
    info,
    () => Promise.reject(new Error("counting graders runs none")),
    () => new Date(),
  );
}

async function datasetGraders(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  folder: () => Promise<FolderSetup>,
  now: () => Date,
): Promise<LabGrader[]> {
  const { environment } = context;
  const specs = graderSpecs(info);
  const settings = trialSettingsOf(info.name, info.dataset);
  const env = definedOf(withoutCallingSession(environment.env ?? process.env));
  let versions = new Map<string, string>();
  if (specs.length > 0) {
    const tmp = realpathSync(environment.tmp ?? tmpdir());
    const work = mkdtempSync(join(tmp, "awf-lab-versions-"));
    try {
      versions = await graderVersions(info, {
        root: workspace.root,
        work,
        env,
        timeoutMs: settings.setupTimeoutMs,
      });
    } catch (error) {
      throw new Refusal(`${info.name}'s graders: ${(error as Error).message}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const workflows = workflowGraders(
    {
      dataset: info,
      awf: async () => (await folder()).awf,
      runner: environment.runner ?? processRunner(),
      runRoot: awfRunsOf(workspace.store),
      now,
    },
    specs,
  );
  const judgeAgent = info.dataset.judgeAgent ?? workspace.judgeAgent;
  const judge = judgeAgent
    ? [
        criteriaJudge(
          {
            runner: environment.runner ?? processRunner(),
            runRoot: awfRunsOf(workspace.store),
            now,
          },
          judgeAgent,
        ),
      ]
    : [];
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

function definedOf(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The run named, by its id or the last four characters of it, or the newest. */
function chooseRun(workspace: CaseWorkspace, names: readonly string[], usage: string): RunRecord {
  if (names.length > 1) throw new Refusal(usage);
  const ids = runIds(workspace.store);
  const given = names[0];
  if (given === undefined) {
    // The store is the project's: another worktree's newest run is not the one you mean.
    const yours = ids.filter((id) => {
      try {
        return readRunRecord(workspace.store, id)?.folders[0]?.path === workspace.root;
      } catch (error) {
        if (error instanceof UnreadableRecord) return false;
        throw error;
      }
    });
    const newest = yours.at(-1) ?? ids.at(-1);
    if (newest === undefined) {
      throw new Refusal(`no runs in ${workspace.store} yet; awf-lab run makes one`);
    }
    return readRunOrRefuse(workspace, newest);
  }
  if (!RUN_ID.test(given) && !/^[0-9a-f]{4}$/.test(given)) {
    throw new Refusal(
      `${usage}\n  a run is its id, such as 20261117-142233-a3f9, or its last four characters`,
    );
  }
  const found = ids.filter((id) => id === given || id.endsWith(`-${given}`));
  if (found.length === 0)
    throw new Refusal(`no run ${given} in ${workspace.store}; awf-lab runs lists them`);
  if (found.length > 1) {
    throw new Refusal(
      `${given} names ${found.length} runs: ${found.join(", ")}; give the whole id`,
    );
  }
  return readRunOrRefuse(workspace, found[0]!);
}

function readRunOrRefuse(workspace: CaseWorkspace, id: string): RunRecord {
  const run = readRunRecord(workspace.store, id);
  if (!run) throw new Refusal(`no run ${id} in ${workspace.store}`);
  return run;
}

/** `report --json`: a run's cases, pooled numbers and agreement, checked against its schema. */
function reportJson(args: {
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
            return {
              label: columnLabel(run, i + 1),
              ...(args.verdicts?.[i] ? { compare: args.verdicts[i] } : {}),
              rates: ratesOf(column),
              ...(() => {
                const d = pairedDifference(rows, column);
                return d ? { difference: d } : {};
              })(),
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

/** How many grades `score` would make again, or why that couldn't be told. */
function staleGrades(
  context: Context,
  info: DatasetInfo,
  cases: readonly CaseInfo[],
  trials: readonly StoredTrial[],
  graders: readonly LabGrader[],
): number | { unread: string } {
  try {
    const plan = planScore({
      trials,
      store: workspaceOf(context).store,
      datasetDir: info.dir,
      cases,
      graders: graders.filter((g) => !g.onDemand),
      decidersOf: (c) => decidersOf(c.key, graders),
      expect: true,
      tmp: realpathSync(context.environment.tmp ?? tmpdir()),
    });
    return [...plan.counts.values()].reduce((a, b) => a + b, 0);
  } catch (error) {
    return { unread: (error as Error).message };
  }
}

async function report(context: Context, names: readonly string[]): Promise<number> {
  const workspace = workspaceOf(context);
  const run = chooseRun(workspace, names, "awf-lab report [{run}] [--case {name}] [--json]");
  let info: DatasetInfo | undefined;
  let cases: CaseInfo[] = [];
  try {
    ({ info, cases } = loadDataset(workspace, run.dataset, "all"));
  } catch {
    // A dataset since removed or broken: its run still reads, at the default bar, every grade
    // deciding.
  }
  let graders: LabGrader[] | undefined;
  let stale: CaseReport["stale"];
  const trials = readTrials(workspace.store, run.id);
  if (info) {
    try {
      graders = await countedGraders(context, workspace, info);
      stale = staleGrades(context, info, cases, trials, graders);
    } catch (error) {
      stale = { unread: (error as Error).message };
    }
  }
  const bars = barsOf(info, cases, graders);
  const rows = rowsOf(workspace.store, run, trials, bars);
  const others = otherColumns(workspace.store, run, trials, bars);
  const personal = personOf(workspace, run.dataset, trials, bars, graders);
  const verdicts = info ? await verdictsOf(context, workspace, info, run, trials, bars) : undefined;
  const { text, exit } = renderRun({
    run,
    rows,
    others,
    trials,
    criteria: criteriaCount(
      cases,
      run.asked.map((a) => a.case),
    ),
    ...(stale !== undefined ? { stale } : {}),
    decidersOf: (name) => bars.get(name)?.deciders,
    tagsOf: (name) => bars.get(name)?.tags ?? [],
    ...(verdicts ? { verdicts } : {}),
    leftOut: unreadableRuns(workspace.store).filter((id) => id < run.id),
    ...personal,
  });
  if (context.options.case) {
    const row = rows.find((r) => r.name === context.options.case);
    if (!row) throw new Refusal(`run ${run.id} has no case ${context.options.case}`);
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
            ...(personal.person ? { person: personal.person } : {}),
          }),
          null,
          2,
        ),
      );
      return exit;
    }
    context.stdout(
      renderCase(
        run,
        row,
        own,
        (runId) => {
          const bin = own.find((t) => t.record.runId === runId)?.record.awf.bin ?? "awf";
          const column = own.find((t) => t.record.runId === runId)?.record.column ?? 0;
          const folder = run.folders[run.columns[column]?.folder ?? 0] ?? run.folders[0]!;
          return `(cd ${folder.path} && bun --no-env-file ${bin} logs ${runId} --run-root ${runRoot})`;
        },
        bars.get(row.name)?.deciders,
        others.map((column) => column.find((r) => r.name === row.name)),
        readLabels(workspace.store, run.dataset),
      ),
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
    const json = reportJson({
      run,
      rows,
      trials,
      exit,
      bars,
      others,
      ...(stale !== undefined ? { stale } : {}),
      ...(personal.person ? { person: personal.person } : {}),
      ...(verdicts ? { verdicts } : {}),
    });
    context.stdout(JSON.stringify(json, null, 2));
  } else context.stdout(text);
  return exit;
}

/**
 * Grades a kept run again, without running a trial: never `env.ts`, the workflow or `observe`.
 * Cheap graders first; a grader workflow is skipped again when the trial still fails a cheap one.
 */
async function score(context: Context, names: readonly string[]): Promise<number> {
  const { options, environment, stderr } = context;
  const workspace = workspaceOf(context);
  const run = chooseRun(
    workspace,
    names,
    "awf-lab score [{run}] [--grader {name}] [--yes] [--dry-run] [--budget {usd}] [--json]",
  );
  const { info, cases } = loadDataset(workspace, run.dataset, "all");
  const now = environment.now ?? (() => new Date());
  let inspected: Promise<FolderSetup> | undefined;
  const graders = await datasetGraders(
    context,
    workspace,
    info,
    () =>
      (inspected ??= (environment.inspect ?? inspectFolder)(
        workspace.root,
        checkEnvFile(info.dir),
      )),
    now,
  );
  let chosen: LabGrader[];
  if (options.judges.length > 0) {
    if (options.grader) throw new Refusal("score takes --grader or --judge, not both");
    // Judges graded beside the one that decides: kept to compare, never in the verdict.
    chosen = options.judges.map((given) => {
      const [harness, ...model] = given.split("/");
      if (!harness || model.length === 0) {
        throw new Refusal(
          `--judge ${given}: give {harness}/{model}, such as claude/claude-sonnet-5-5`,
        );
      }
      const agent = {
        harness,
        model: model.join("/"),
        ...(options.voters ? { voters: options.voters } : {}),
      };
      return criteriaJudge(
        {
          runner: environment.runner ?? processRunner(),
          runRoot: awfRunsOf(workspace.store),
          now,
        },
        agent,
        true,
      );
    });
  } else if (options.grader) {
    const one = graders.find((g) => g.name === options.grader);
    if (!one) {
      throw new Refusal(
        `no grader ${options.grader} in ${info.name}; its graders: ${graders.map((g) => g.name).join(", ") || "none"}`,
      );
    }
    chosen = [one];
  } else chosen = graders.filter((g) => !g.onDemand);
  const tmp = realpathSync(environment.tmp ?? tmpdir());
  const trials = readTrials(workspace.store, run.id);
  const byCase = new Map(cases.map((c) => [c.name, c]));
  const plan = planScore({
    trials: options.tags
      ? trials.filter((t) => {
          const info = byCase.get(t.record.case);
          return info !== undefined && tagged(info, options.tags!);
        })
      : trials,
    store: workspace.store,
    datasetDir: info.dir,
    cases,
    graders: chosen,
    decidersOf: (c) => decidersOf(c.key, graders),
    expect: options.grader === undefined && options.judges.length === 0,
    tmp,
  });
  const described = describePlan(plan, run.id);
  const planJson: Scored["plan"] = {
    run: run.id,
    trials: plan.items.length,
    grades: Object.fromEntries(plan.counts),
    maybe: Object.fromEntries(plan.maybe),
    ...(plan.estimate !== undefined ? { estimate: plan.estimate } : {}),
    ...(plan.upTo !== undefined ? { upTo: plan.upTo } : {}),
    unpriced: plan.unpriced,
    changed: plan.changed.map((t) => ({ case: t.record.case, trial: t.record.trial })),
  };
  const print = (scored: Scored) => {
    const checked = checkSchema(ScoredSchema, scored);
    if (!checked.ok) throw new Error(describeProblems("score --json", checked.problems));
    context.stdout(JSON.stringify(scored, null, 2));
  };
  if (options.dryRun) {
    if (options.json) print({ kind: SCORED_KIND, plan: planJson });
    else context.stdout(described);
    return 0;
  }
  let done: ScoreDone | undefined;
  if (plan.items.length > 0) {
    // The question goes to stderr, so `--json` still asks at a terminal: grading costs money.
    const confirm =
      environment.confirm ??
      (process.stdin.isTTY && !options.yes
        ? (text: string) => askOperator(text, stderr, "grade them?")
        : undefined);
    if (confirm && !options.yes) {
      if (!(await confirm(described))) {
        stderr("declined; nothing graded");
        return 2;
      }
    } else stderr(described);
    const lock = takeLock(workspace.labHome);
    if ("heldBy" in lock) throw new Refusal(lockHeld(workspace, lock.heldBy));
    try {
      clearStale(tmp);
      done = await runScore({
        plan,
        tmp,
        run: run.id,
        store: workspace.store,
        env: definedOf(withoutCallingSession(environment.env ?? process.env)),
        ...(options.budget !== undefined ? { budget: options.budget } : {}),
        now,
        progress: stderr,
      });
    } finally {
      if (workspace.records) writeRecords(workspace.store, workspace.records, run.id);
      lock.release();
    }
  } else stderr(described);
  const bars = barsOf(info, cases, graders);
  const after = readTrials(workspace.store, run.id);
  const rows = rowsOf(workspace.store, run, after, bars);
  const personal = personOf(workspace, run.dataset, after, bars, graders);
  const verdicts = await verdictsOf(context, workspace, info, run, after, bars);
  const rendered = renderRun({
    run,
    rows,
    others: otherColumns(workspace.store, run, after, bars),
    trials: after,
    criteria: criteriaCount(
      cases,
      run.asked.map((a) => a.case),
    ),
    decidersOf: (name) => bars.get(name)?.deciders,
    tagsOf: (name) => bars.get(name)?.tags ?? [],
    ...(verdicts ? { verdicts } : {}),
    leftOut: unreadableRuns(workspace.store).filter((id) => id < run.id),
    ...personal,
  });
  // A budget stop leaves grades unmade: 3, unless the report already exits worse.
  const exit = done?.stopped && rendered.exit === 0 ? 3 : rendered.exit;
  if (options.json) {
    print({
      kind: SCORED_KIND,
      plan: planJson,
      ...(done
        ? {
            done: {
              graded: Object.fromEntries(done.graded),
              errored: Object.fromEntries(done.errored),
              estimate: done.estimate,
              stopped: done.stopped,
            },
          }
        : {}),
      report: reportJson({
        run,
        rows,
        trials: after,
        exit,
        bars,
        others: otherColumns(workspace.store, run, after, bars),
        ...(personal.person ? { person: personal.person } : {}),
        ...(verdicts ? { verdicts } : {}),
      }),
    });
    return exit;
  }
  const lines: string[] = [];
  if (done) {
    const counted = (map: Map<string, number>) =>
      [...map].map(([name, n]) => `${name} ×${n}`).join(", ");
    lines.push(
      [
        `graded again: ${counted(done.graded) || "nothing"}`,
        ...(done.errored.size > 0 ? [`errored: ${counted(done.errored)}`] : []),
        ...(done.estimate > 0 ? [`est. $${done.estimate.toFixed(2)}`] : []),
        ...(done.stopped
          ? [`stopped at the budget, $${options.budget!.toFixed(2)}: the rest is not graded`]
          : []),
      ].join(" · "),
      "",
    );
  }
  const text =
    done?.stopped && rendered.exit === 0
      ? rendered.text.replace(/exit 0: .*$/, "exit 3: score stopped at its budget")
      : rendered.text;
  context.stdout([...lines, text].join("\n"));
  return exit;
}

/**
 * `capture {run id}`: a case from a past run of the workflow. A trial's run has its case: its own
 * `files/` and `input.json` are copied, and `--good` drafts `expect` from the trial's facts. A real
 * run, from the project's `.awf/runs`, becomes cases through the dataset's `capture.ts`. Every key
 * is a draft, so no grader runs on it until the person finishes it.
 */
async function captureCommand(context: Context, names: readonly string[]): Promise<number> {
  const { options } = context;
  const usage = 'awf-lab capture {run id} (--good | --needs-work "{note}") [--dataset {name}]';
  const [runId, ...extra] = names;
  if (!runId || extra.length > 0) throw new Refusal(usage);
  if (options.good === (options.needsWork !== undefined)) {
    throw new Refusal(`say how the run went, --good or --needs-work "{note}": ${usage}`);
  }
  const mark: Mark = options.good
    ? { mark: "good" }
    : { mark: "needs-work", note: options.needsWork! };
  const workspace = workspaceOf(context);
  const { info } = loadDataset(workspace, options.dataset);
  const lock = takeLock(workspace.labHome);
  if ("heldBy" in lock) throw new Refusal(lockHeld(workspace, lock.heldBy));
  try {
    return await captureLocked(context, workspace, info, runId, mark);
  } finally {
    lock.release();
  }
}

async function captureLocked(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  runId: string,
  mark: Mark,
): Promise<number> {
  const { environment } = context;
  const say = (dir: string, from: string) =>
    context.stdout(
      `wrote ${relative(context.cwd, dir) || dir}, ${from}: its key is a draft to finish`,
    );

  const trial = findTrial(workspace.store, runId);
  if (trial) {
    if (trial.record.dataset !== info.name) {
      throw new Refusal(
        `run ${runId} is a trial of dataset ${trial.record.dataset}: --dataset ${trial.record.dataset}`,
      );
    }
    const source = join(info.dir, "cases", trial.record.case);
    if (!existsSync(source))
      throw new Refusal(`case ${trial.record.case} is no longer in ${info.name}`);
    const inputFile = join(source, "input.json");
    const dir = writeCase(info, freeName(info, trial.record.case), {
      filesFrom: join(source, "files"),
      ...(existsSync(inputFile) ? { input: JSON.parse(readFileSync(inputFile, "utf8")) } : {}),
      key: capturedKey(runId, mark, trial.record.facts),
    });
    say(
      dir,
      `from trial ${trial.record.trial} of case ${trial.record.case} in run ${trial.record.run}`,
    );
    // The case says what a good result is; the trial it came from keeps the person's verdict.
    labelTrial(
      workspace,
      trial,
      mark.mark,
      mark.mark === "needs-work" ? mark.note : undefined,
      context.environment.now ?? (() => new Date()),
    );
    if (folderDigestOfCase(info, trial.record.case) !== trial.record.input) {
      context.stderr(
        `note: case ${trial.record.case} changed since that trial ran; its files were copied as they are now`,
      );
    }
    return 0;
  }

  const found = findRealRun(
    [workspace.root, ...(workspace.repository ? [workspace.repository] : [])],
    runId,
  );
  if (!found) {
    throw new Refusal(
      `no run ${runId}: neither a trial in ${workspace.store} nor a run in ${join(workspace.root, ".awf/runs")}`,
    );
  }
  const file = join(info.dir, CAPTURE_FILE);
  if (!existsSync(file)) {
    throw new Refusal(
      `run ${runId} is a real run: ${relative(context.cwd, file) || file} turns one into cases, and ${info.name} has none`,
    );
  }
  const tmp = realpathSync(environment.tmp ?? tmpdir());
  const work = mkdtempSync(join(tmp, "awf-lab-capture-"));
  let answer: { cases?: unknown; error?: string };
  try {
    answer = (await runHelper(
      { mode: "capture", file, input: { run: readRealRun(found), root: workspace.root } },
      {
        root: workspace.root,
        work,
        env: definedOf(withoutCallingSession(environment.env ?? process.env)),
        timeoutMs: trialSettingsOf(info.name, info.dataset).setupTimeoutMs,
        name: "capture",
      },
    )) as typeof answer;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (answer.error !== undefined) throw new Refusal(`${file}: ${answer.error}`);
  const run = readRealRun(found);
  if (mark.mark === "good" && run.outcome !== "completed") {
    throw new Refusal(
      `run ${runId} of ${run.workflow} ${run.outcome === "running" ? "has not ended" : `ended ${run.outcome}`}: --good takes a completed run; --needs-work "{note}" captures it`,
    );
  }
  const taken = new Set<string>();
  for (const each of checkCaptured(file, answer.cases)) {
    const name = freeName(info, each.name, taken);
    taken.add(name);
    const dir = writeCase(info, name, {
      ...(each.files ? { files: each.files } : {}),
      ...(each.input !== undefined ? { input: each.input } : {}),
      key: capturedKey(runId, mark, each.facts),
    });
    say(dir, `from ${run.workflow}'s run ${runId}`);
  }
  return 0;
}

/** A case as a trial would be built from it now, for its digest. */
function folderDigestOfCase(info: DatasetInfo, name: string): string | undefined {
  const tmp = mkdtempSync(join(tmpdir(), "awf-lab-capture-case-"));
  try {
    const found = readCases(info).find((c) => c.name === name);
    if (!found) return undefined;
    buildCase(info.dir, found, tmp);
    return folderDigest(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `label`: the person's verdict on one trial, found by its workflow run's id, as `capture` finds
 * it. A coding agent the person told what was wrong runs it too, and a web interface would.
 */
function label(context: Context, names: readonly string[]): number {
  const { options } = context;
  const usage = 'awf-lab label {run id} (--good | --needs-work "{note}" | --clear)';
  const given = [options.good, options.needsWork !== undefined, options.clear].filter(Boolean);
  if (names.length !== 1 || given.length !== 1) throw new Refusal(usage);
  const workspace = workspaceOf(context);
  const runId = names[0]!;
  const trial = findTrial(workspace.store, runId);
  if (!trial) {
    throw new Refusal(
      `no trial ran as ${runId} in ${workspace.store}; awf-lab report --case {name} shows each trial's run id`,
    );
  }
  const mark = options.good ? "good" : options.clear ? "cleared" : "needs-work";
  labelTrial(
    workspace,
    trial,
    mark,
    options.needsWork,
    context.environment.now ?? (() => new Date()),
  );
  const { record } = trial;
  context.stdout(
    mark === "cleared"
      ? `cleared the label of ${record.case} trial ${record.trial}`
      : `labeled ${record.case} trial ${record.trial} ${mark}${options.needsWork ? `: ${options.needsWork}` : ""}`,
  );
  return 0;
}

function labelTrial(
  workspace: CaseWorkspace,
  trial: StoredTrial,
  mark: LabelMark,
  note: string | undefined,
  now: () => Date,
): void {
  appendLabel(workspace.store, trial.record.dataset, {
    kind: LABEL_KIND,
    runId: trial.record.runId!,
    case: trial.record.case,
    mark,
    ...(note ? { note } : {}),
    at: now().toISOString(),
  });
  if (workspace.records) writeLabels(workspace.store, workspace.records);
}

function lockHeld(workspace: CaseWorkspace, heldBy: number | undefined): string {
  const file = join(workspace.labHome, "lock");
  return heldBy === undefined
    ? `${file} holds no process this lab can read: remove it once no awf-lab runs`
    : `another awf-lab run or score (process ${heldBy}) holds ${file}`;
}

function runs(context: Context): number {
  const workspace = workspaceOf(context);
  const lines = runIds(workspace.store)
    .reverse()
    .flatMap((n) => {
      let run: RunRecord | undefined;
      let state: string;
      try {
        run = readRunRecord(workspace.store, n);
        if (run) readTrials(workspace.store, n);
        state = run?.broke ? "the lab broke" : run?.finished ? "finished" : "partial";
      } catch (error) {
        if (!(error instanceof UnreadableRecord)) throw error;
        // "{file} is not valid:" then its problems: the file's name and the first problem do.
        const [head = "", first] = (error as Error).message.split("\n");
        const why = `${basename(head.replace(/ is not valid:$/, ""))}${first ? `: ${first.trim()}` : ""}`;
        if (!run) return [`${n}  records don't read: ${why}`];
        state = `records don't read (${why}), left out of history`;
      }
      if (!run) return [];
      const trials = run.asked.reduce((sum, a) => sum + a.trials, 0);
      return [
        `${n}  ${run.dataset}  ${plural(run.asked.length, "case")}, ${plural(trials, "trial")}  ${state}`,
      ];
    });
  context.stdout(lines.length > 0 ? lines.join("\n") : `no runs in ${workspace.store} yet`);
  return 0;
}
