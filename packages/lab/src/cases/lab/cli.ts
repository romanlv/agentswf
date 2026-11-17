import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { findConfigFile } from "../../shared/config-file";
import { awfLogs, processRunner, type Runner } from "../../shared/runner";
import { RUN_KIND, type RunRecord } from "../format/records";
import { codeGraders } from "./code-graders";
import { type CaseInfo, type DatasetInfo, fileDigest, readCases, readDataset } from "./dataset";
import { clearStale } from "./folders";
import { gitState, gitTop } from "./git";
import { checkEnvFile, type FolderSetup, inspectFolder } from "./inspect";
import { trialOutcome } from "./outcome";
import { Refusal } from "./refusal";
import { median, plural, renderCase, renderRun, seconds } from "./report";
import { barsOf, criteriaCount, failedCases, rowsOf } from "./runs";
import { newCase } from "./scaffold";
import {
  awfRunsOf,
  claimRun,
  clearStaleTrialFiles,
  readRunRecord,
  readTrials,
  runNumbers,
  takeLock,
  writeRun,
  writeTrial,
} from "./store";
import { type LabGrader, runTrial, type TrialDone, type TrialLab } from "./trial";
import { trialSettingsOf } from "./trial-settings";
import { type CaseWorkspace, chooseDataset, openCaseWorkspace } from "./workspace";

export const CASES_USAGE = `usage: awf-lab [--config {file}] {command} …

  case new {dataset}/{case}   a case folder and its key's marker; the first time, also
                              awf-lab.json, the dataset's dataset.json and a stub env.ts
  run [--dataset {name}] [--cases {a,b}] [--failed] [--trials {n}] [--yes]
                              the workflow, as it is in your checkout, on each case, each trial
                              in a throwaway folder, graded against its key
  report [{n}] [--case {name}]
                              the last run again, or run n; one case in full with --case
  runs                        the runs kept, newest first

  --dataset {name}  the dataset: a folder beside awf-lab.json holding a dataset.json; with one,
                    never named
  --cases {a,b}     only these cases
  --failed          only the cases whose newest verdict was failed, flaky or unclear, each with
                    that run's trials unless --trials says
  --trials {n}      trials a case; 1 unless told
  --yes             no question before a run

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
  /** Graders a test adds after `expect`; task 3 builds the real interface. */
  graders?: readonly LabGrader[];
  now?: () => Date;
};

type Options = {
  config?: string;
  dataset?: string;
  cases?: string[];
  failed: boolean;
  trials?: number;
  yes: boolean;
  case?: string;
  help: boolean;
};

/** The lab broke during a run: exit 4. */
class LabBroke extends Error {}

function parse(argv: readonly string[]): { command?: string; names: string[]; options: Options } {
  const options: Options = { failed: false, yes: false, help: false };
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
      case "--case":
        options.case = value(arg);
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Refusal(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  const [command, ...names] = positional;
  return { ...(command ? { command } : {}), names, options };
}

type Context = {
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
  return openCaseWorkspace(config, context.home);
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
        return report(context, names);
      case "runs":
        return runs(context);
      default:
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

function loadDataset(
  workspace: CaseWorkspace,
  name?: string,
): { info: DatasetInfo; cases: CaseInfo[] } {
  const chosen = chooseDataset(workspace, name);
  const info = readDataset(chosen.name, chosen.dir);
  return { info, cases: readCases(info) };
}

async function askOperator(plan: string, stderr: (text: string) => void): Promise<boolean> {
  stderr(plan);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question("run it? [y/N] ")).trim());
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
  for (const n of runNumbers(store)) {
    const record = readRunRecord(store, n);
    if (record?.dataset !== dataset) continue;
    for (const { record: trial, scores } of readTrials(store, n)) {
      if (!names.includes(trial.case) || !trial.runId) continue;
      if (trialOutcome(trial, scores).outcome === "errored") continue;
      ms.push(trial.ms);
      if (trial.estimate !== undefined) cost.push(trial.estimate);
    }
  }
  const time = median(ms);
  if (time === undefined) return undefined;
  const each = median(cost);
  return `from earlier trials: about ${seconds(time * count)}${each !== undefined ? `, est. $${(each * count).toFixed(2)}` : ""}`;
}

async function run(context: Context): Promise<number> {
  const { options, environment, stderr } = context;
  const workspace = workspaceOf(context);
  const { info, cases } = loadDataset(workspace, options.dataset);
  const bars = barsOf(info, cases);
  const byName = new Map(cases.map((c) => [c.name, c]));
  for (const name of options.cases ?? []) {
    if (!byName.has(name)) {
      throw new Refusal(
        `no case ${name} in ${info.name}; known: ${cases.map((c) => c.name).join(", ")}`,
      );
    }
  }
  let selected = options.cases ? cases.filter((c) => options.cases!.includes(c.name)) : cases;
  const failed = options.failed
    ? failedCases(workspace.store, info.name, workspace.root, bars)
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
  const folder = await (environment.inspect ?? inspectFolder)(workspace.root, envFile);
  const state = gitState(workspace.root);

  const total = selected.reduce((n, c) => n + trialsOf(c.name), 0);
  const counts = new Set(selected.map((c) => trialsOf(c.name)));
  const plan = [
    `${info.name} · ${plural(selected.length, "case")} · ${counts.size === 1 ? `${plural([...counts][0]!, "trial")} each` : plural(total, "trial")}`,
    `code: this checkout, ${state.branch ? `branch ${state.branch}` : "detached"}${state.commit ? `, commit ${state.commit.slice(0, 7)}` : ""}${state.dirty ? ", with uncommitted changes" : ""}`,
    `awf: agentswf ${folder.version}`,
    ...[
      estimate(
        workspace.store,
        info.name,
        selected.map((c) => c.name),
        total,
      ),
    ].filter((line): line is string => line !== undefined),
  ].join("\n");
  const confirm =
    environment.confirm ??
    (process.stdin.isTTY && !options.yes ? (text: string) => askOperator(text, stderr) : undefined);
  if (confirm && !options.yes) {
    if (!(await confirm(plan))) {
      stderr("declined; nothing run");
      return 2;
    }
  } else stderr(plan);

  const lock = takeLock(workspace.labHome);
  if ("heldBy" in lock) {
    const file = join(workspace.labHome, "lock");
    throw new Refusal(
      lock.heldBy === undefined
        ? `${file} holds no process this lab can read: remove it once no awf-lab runs`
        : `another awf-lab run (process ${lock.heldBy}) holds ${file}`,
    );
  }
  let record: RunRecord | undefined;
  try {
    const number = claimRun(workspace.store);
    const now = environment.now ?? (() => new Date());
    record = {
      kind: RUN_KIND,
      number,
      dataset: info.name,
      folders: [{ path: workspace.root, ...state, env: fileDigest(envFile) }],
      asked: selected.map((c) => ({ case: c.name, trials: trialsOf(c.name) })),
      started: now().toISOString(),
    };
    writeRun(workspace.store, record);
    const tmp = realpathSync(environment.tmp ?? tmpdir());
    clearStale(tmp);
    clearStaleTrialFiles(workspace.labHome);
    const lab: TrialLab = {
      workspace,
      dataset: info,
      envFile,
      run: number,
      runner: environment.runner ?? processRunner(),
      logs: environment.logs ?? awfLogs,
      tmp,
      env: environment.env ?? process.env,
      graders: [
        ...(environment.graders ?? []),
        ...codeGraders(
          info,
          workspace.root,
          trialSettingsOf(info.name, info.dataset).setupTimeoutMs,
        ),
      ],
      now,
    };
    const most = Math.max(...selected.map((c) => trialsOf(c.name)));
    try {
      for (let trial = 1; trial <= most; trial++) {
        const again: CaseInfo[] = [];
        for (const info of selected.filter((c) => trialsOf(c.name) >= trial)) {
          const done = await runTrial(lab, folder, info, 0, trial);
          progress(stderr, done);
          if (done.record.errored?.by === "provider") again.push(info);
        }
        for (const info of again) {
          const done = await runTrial(lab, folder, info, 0, trial);
          const retried = { ...done.record, retried: true };
          writeTrial(done.dir, retried);
          progress(stderr, { ...done, record: retried });
        }
      }
    } catch (error) {
      record = { ...record, broke: (error as Error).message };
      writeRun(workspace.store, record);
      throw new LabBroke(`the lab broke during run ${number}: ${(error as Error).message}`);
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
    lock.release();
  }
  const trials = readTrials(workspace.store, record.number);
  const rows = rowsOf(workspace.store, record, trials, bars);
  const { text, exit } = renderRun({ run: record, rows, trials, criteria });
  context.stdout(text);
  return exit;
}

function progress(stderr: (text: string) => void, done: TrialDone): void {
  const view = trialOutcome(done.record, done.score ? [done.score] : []);
  stderr(
    `  ${done.record.case} ${done.record.trial}: ${view.outcome}${done.record.retried ? " (tried again)" : ""} · ${seconds(done.record.ms)}`,
  );
}

function report(context: Context, names: readonly string[]): number {
  const workspace = workspaceOf(context);
  if (names.length > 1 || (names[0] !== undefined && !/^[1-9][0-9]*$/.test(names[0]))) {
    throw new Refusal("awf-lab report [{n}] [--case {name}]");
  }
  const numbers = runNumbers(workspace.store);
  const number = names[0] ? Number(names[0]) : numbers.at(-1);
  if (number === undefined)
    throw new Refusal(`no runs in ${workspace.store} yet; awf-lab run makes one`);
  const run = readRunRecord(workspace.store, number);
  if (!run) throw new Refusal(`no run ${number} in ${workspace.store}`);
  let info: DatasetInfo | undefined;
  let cases: CaseInfo[] = [];
  try {
    ({ info, cases } = loadDataset(workspace, run.dataset));
  } catch {
    // A dataset since removed or broken: its run still reads, at the default bar.
  }
  const bars = barsOf(info, cases);
  const trials = readTrials(workspace.store, number);
  const rows = rowsOf(workspace.store, run, trials, bars);
  const { text, exit } = renderRun({
    run,
    rows,
    trials,
    criteria: criteriaCount(
      cases,
      run.asked.map((a) => a.case),
    ),
  });
  if (context.options.case) {
    const row = rows.find((r) => r.name === context.options.case);
    if (!row) throw new Refusal(`run ${number} has no case ${context.options.case}`);
    const own = trials.filter((t) => t.record.case === row.name && t.record.column === 0);
    const runRoot = awfRunsOf(workspace.store);
    context.stdout(
      renderCase(run, row, own, (runId) => {
        const bin = own.find((t) => t.record.runId === runId)?.record.awf.bin ?? "awf";
        return `(cd ${run.folders[0]!.path} && bun --no-env-file ${bin} logs ${runId} --run-root ${runRoot})`;
      }),
    );
  } else context.stdout(text);
  return exit;
}

function runs(context: Context): number {
  const workspace = workspaceOf(context);
  const lines = runNumbers(workspace.store)
    .reverse()
    .flatMap((n) => {
      const run = readRunRecord(workspace.store, n);
      if (!run) return [];
      const trials = run.asked.reduce((sum, a) => sum + a.trials, 0);
      const state = run.broke ? "the lab broke" : run.finished ? "finished" : "partial";
      return [
        `${String(n).padStart(4)}  ${run.started.slice(0, 16).replace("T", " ")}  ${run.dataset}  ${plural(run.asked.length, "case")}, ${plural(trials, "trial")}  ${state}`,
      ];
    });
  context.stdout(lines.length > 0 ? lines.join("\n") : `no runs in ${workspace.store} yet`);
  return 0;
}
