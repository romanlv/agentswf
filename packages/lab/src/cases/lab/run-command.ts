import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type Column, type Params, RUN_KIND, type RunRecord } from "../format/records";
import { columnLabel, columnsOf, combinations, type ParamPlan, readParams } from "./columns";
import {
  askOperator,
  type Context,
  datasetGraders,
  envOf,
  externalsOf,
  loadDataset,
  lockHeld,
  runReport,
  tagged,
  tmpOf,
  workspaceOf,
} from "./command-context";
import { type CaseInfo, type DatasetInfo, ENV_FILE, fileDigest } from "./dataset";
import { clearStale } from "./folders";
import { gitState } from "./git";
import type { LabGrader } from "./grading";
import { checkEnvFile, type FolderSetup, inspectFolder } from "./inspect";
import { gradingSpend, trialOutcome, trialSpend } from "./outcome";
import { writeRecords } from "./record-copies";
import { Refusal } from "./refusal";
import { describeFolder, median, plural, seconds, usd } from "./report";
import {
  caseDigests,
  codeDigest,
  REUSE_DAYS,
  reusableTrials,
  reuseKey,
  reuseTrial,
  trialShaping,
} from "./reuse";
import { barsOf, type CaseBar, criteriaCount, failedCases } from "./runs";
import { regradePlan, runScore, type ScoreDone, type ScorePlan } from "./score";
import {
  claimRun,
  clearStaleTrialFiles,
  readableRuns,
  readTrials,
  type StoredTrial,
  takeLock,
  writeRun,
  writeTrial,
} from "./store";
import { runTrial, type TrialDone, type TrialLab } from "./trial";
import { type CaseWorkspace, codeFolderOf, inside } from "./workspace";

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

/** How a run ended: its exit, its id once it started, and why it never did. */
export type RunDone = { exit: number; id?: string; unstarted?: string };

/** The lab broke during a run: exit 4. */
class LabBroke extends Error {}

/** A folder of code, its `env.ts` and its git state. */
type CodeFolder = { folder: FolderSetup; envFile: string; state: ReturnType<typeof gitState> };

/** The trials kept from earlier runs that stand in for new ones, and what they need graded again. */
type Reuse = {
  /** Per case and column, the stored trials that are its first ones. */
  slots: Map<string, { column: number; trials: StoredTrial[] }>;
  count: number;
  /** A trial's reuse key in column `n`, from its built case's digest. */
  keyOf: (n: number, input: string) => string | undefined;
  /** The reused trials a key or grader changed for since they were graded. */
  regrade?: ScorePlan;
};

const slotOf = (name: string, column: number) => `${name}\0${column}`;

export async function run(context: Context, given: RunGiven = {}): Promise<RunDone> {
  const { options, environment, stderr } = context;
  const workspace = workspaceOf(context);
  const { info, cases } = loadDataset(workspace, options.dataset, options.holdout);
  if (options.holdout && cases.length === 0) {
    throw new Refusal(`${info.name} holds out no case: name them in dataset.json's holdout`);
  }
  const now = environment.now ?? (() => new Date());
  let checkedEnv: string | undefined;
  const envFileOf = () => (checkedEnv ??= checkEnvFile(info.dir));
  let inspected: Promise<FolderSetup> | undefined;
  const folderOf = () =>
    (inspected ??= (environment.inspect ?? inspectFolder)(workspace.root, envFileOf()));
  const graders = await datasetGraders(context, workspace, info, folderOf, now);
  const bars = barsOf(info, cases, graders);
  const paramPlan = readParams(options.param, options.vary);
  const combos = combinations(paramPlan);
  const chosen = selectCases(context, workspace, info, cases, bars, combos[0]!, given);
  if ("nothing" in chosen) {
    context.stdout(chosen.nothing);
    return { exit: chosen.exit, unstarted: chosen.nothing };
  }
  const { selected, trialsOf } = chosen;
  const envFile = envFileOf();
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
  const tmp = tmpOf(context);
  const reuse = planReuse({
    context,
    workspace,
    info,
    cases,
    selected,
    trialsOf,
    columns,
    codeFolders,
    graders,
    tmp,
    now,
  });
  const plan = planText({
    workspace,
    info,
    selected,
    trialsOf,
    codeFolders,
    paramPlan,
    columns,
    reuse,
  });
  if (options.dryRun) {
    context.stdout(plan);
    return { exit: 0, unstarted: "a dry run" };
  }
  const withBudget =
    options.budget !== undefined
      ? `${plan}\nstops starting trials once their estimates reach ${usd(options.budget)}`
      : plan;
  const confirm =
    environment.confirm ??
    (process.stdin.isTTY && !options.yes ? (text: string) => askOperator(text, stderr) : undefined);
  if (confirm && !options.yes) {
    if (!(await confirm(withBudget))) {
      stderr("declined; nothing run");
      return { exit: 2, unstarted: "declined" };
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
    const { runner, logs, estimate } = externalsOf(environment);
    const lab: TrialLab = {
      workspace,
      dataset: info,
      envFile,
      run: id,
      runner,
      logs,
      ...(estimate ? { estimate } : {}),
      tmp,
      env: environment.env ?? process.env,
      graders,
      now,
    };
    try {
      record = await runPasses({
        context,
        lab,
        record,
        selected,
        trialsOf,
        codeFolders,
        reuse,
        bars,
        given,
      });
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
      return { exit: 4, ...(record ? { id: record.id } : {}) };
    }
    throw error;
  } finally {
    if (record && workspace.records) writeRecords(workspace.store, workspace.records, record.id);
    lock.release();
  }
  const report = await runReport(context, workspace, {
    info,
    run: record,
    trials: readTrials(workspace.store, record.id),
    bars,
    graders,
    criteria,
  });
  // A budget stop leaves trials unrun: 3, unless the report already exits worse.
  const exit = record.stopped === "budget" && report.exit === 0 ? 3 : report.exit;
  if (given.report !== false) {
    context.stdout(options.json ? JSON.stringify(report.json(exit), null, 2) : report.text);
  }
  return { exit, id: record.id };
}

/** The cases to run and each one's trials: `--cases`, a loop's order, `--tags` and `--failed`. */
function selectCases(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  cases: readonly CaseInfo[],
  bars: ReadonlyMap<string, CaseBar>,
  reference: Params,
  given: RunGiven,
):
  | { selected: CaseInfo[]; trialsOf: (name: string) => number }
  | { nothing: string; exit: number } {
  const { options } = context;
  const byName = new Map(cases.map((c) => [c.name, c]));
  for (const name of options.cases ?? []) {
    if (!byName.has(name)) {
      throw new Refusal(
        `no case ${name} in ${info.name}; known: ${cases.map((c) => c.name).join(", ")}`,
      );
    }
  }
  let selected = given.order
    ? given.order.flatMap((name) => byName.get(name) ?? [])
    : options.cases
      ? cases.filter((c) => options.cases!.includes(c.name))
      : [...cases];
  if (options.tags) selected = selected.filter((c) => tagged(c, options.tags!));
  const failed = options.failed
    ? failedCases(workspace.store, info.name, workspace.root, reference, bars)
    : undefined;
  if (failed) selected = selected.filter((c) => failed.has(c.name));
  if (selected.length === 0) {
    return options.failed
      ? { nothing: "nothing to run: no case's newest verdict is failed, flaky or unclear", exit: 0 }
      : {
          nothing: `no cases in ${info.dir}; awf-lab case new ${info.name}/{case} makes one`,
          exit: 2,
        };
  }
  return { selected, trialsOf: (name) => options.trials ?? failed?.get(name) ?? 1 };
}

/**
 * Trials that ran before on what shapes a trial now, kept within reuseDays, stand in for new ones.
 * --failed asks for new evidence on what failed: the trials that failed are never its answer.
 */
function planReuse(args: {
  context: Context;
  workspace: CaseWorkspace;
  info: DatasetInfo;
  cases: readonly CaseInfo[];
  selected: readonly CaseInfo[];
  trialsOf: (name: string) => number;
  columns: readonly Column[];
  codeFolders: readonly CodeFolder[];
  graders: readonly LabGrader[];
  tmp: string;
  now: () => Date;
}): Reuse {
  const { options } = args.context;
  const { workspace, info, columns, codeFolders } = args;
  const days = options.fresh || options.failed ? 0 : (info.dataset.reuseDays ?? REUSE_DAYS);
  const codes = codeFolders.map((c) =>
    days > 0 ? codeDigest(c.folder.root, workspace) : undefined,
  );
  const settings = trialShaping(info.dataset, workspace.hide);
  const inputs = caseDigests(info.dir, args.selected, args.tmp);
  const keyOf = (n: number, input: string) => {
    const { folder, params } = columns[n]!;
    const code = codes[folder];
    const awf = codeFolders[folder]!.folder.version;
    return code ? reuseKey({ code, params, input, settings, awf }) : undefined;
  };
  const stored =
    days > 0
      ? reusableTrials(workspace.store, info.name, args.now(), days)
      : new Map<string, StoredTrial[]>();
  const slots: Reuse["slots"] = new Map();
  // One workflow run stands for one trial of one column: two columns that shape trials alike,
  // such as a clone at the same commit, each get trials of their own, or the pair is no check.
  const taken = new Set<string>();
  for (const c of args.selected) {
    for (const n of columns.keys()) {
      const key = keyOf(n, inputs.get(c.name)!);
      const found = key
        ? (stored.get(key) ?? []).filter(
            (t) => t.record.case === c.name && !taken.has(t.record.runId!),
          )
        : [];
      const chosen = found.slice(0, args.trialsOf(c.name));
      for (const t of chosen) taken.add(t.record.runId!);
      if (chosen.length > 0) slots.set(slotOf(c.name, n), { column: n, trials: chosen });
    }
  }
  const reused = [...slots.values()].flatMap((s) => s.trials);
  const regrade =
    reused.length > 0
      ? regradePlan({
          trials: reused,
          store: workspace.store,
          info,
          cases: args.cases,
          graders: args.graders,
          tmp: args.tmp,
        })
      : undefined;
  return {
    slots,
    count: reused.length,
    keyOf,
    ...(regrade && regrade.items.length > 0 ? { regrade } : {}),
  };
}

/** The plan a run asks about: its cases and trials, code, parameters, reuse and estimate. */
function planText(args: {
  workspace: CaseWorkspace;
  info: DatasetInfo;
  selected: readonly CaseInfo[];
  trialsOf: (name: string) => number;
  codeFolders: readonly CodeFolder[];
  paramPlan: ParamPlan;
  columns: readonly Column[];
  reuse: Reuse;
}): string {
  const { info, selected, trialsOf, columns, reuse } = args;
  const total = selected.reduce((n, c) => n + trialsOf(c.name), 0);
  const counts = new Set(selected.map((c) => trialsOf(c.name)));
  const regrade = reuse.regrade;
  return [
    `${info.name} · ${plural(selected.length, "case")} · ${counts.size === 1 ? `${plural([...counts][0]!, "trial")} each` : plural(total, "trial")}`,
    ...args.codeFolders.map(
      (c, i) =>
        `${i === 0 ? "code" : `against ${i}`}: ${describeFolder({ path: i === 0 ? undefined : c.folder.root, ...c.state })} · agentswf ${c.folder.version}`,
    ),
    ...paramLines(args.paramPlan, columns.length),
    ...(reuse.count > 0
      ? [
          `reuses ${reuse.count} of ${plural(total * columns.length, "trial")}: nothing that shaped them changed; --fresh runs new ones`,
        ]
      : []),
    ...(regrade
      ? [
          `grades ${plural(regrade.items.length, "reused trial")} again, a key or grader changed${regrade.estimate !== undefined ? `: est. ${usd(regrade.estimate)}${regrade.upTo !== undefined && regrade.upTo > regrade.estimate ? `, up to ${usd(regrade.upTo)}` : ""}` : ""}`,
        ]
      : []),
    ...[
      estimate(
        args.workspace.store,
        info.name,
        selected.map((c) => c.name),
        total * columns.length - reuse.count,
      ),
    ].filter((line): line is string => line !== undefined),
  ].join("\n");
}

/**
 * The run's trials: the reused ones put in place and graded again where a key or grader changed,
 * then trial t of every case, then t + 1; under a loop's `stop`, a case's every trial first. Stops
 * starting trials once their estimates reach `--budget`.
 */
async function runPasses(args: {
  context: Context;
  lab: TrialLab;
  record: RunRecord;
  selected: readonly CaseInfo[];
  trialsOf: (name: string) => number;
  codeFolders: readonly CodeFolder[];
  reuse: Reuse;
  bars: ReadonlyMap<string, CaseBar>;
  given: RunGiven;
}): Promise<RunRecord> {
  const { context, lab, selected, trialsOf, codeFolders, reuse, bars, given } = args;
  const { budget } = context.options;
  const { store } = lab.workspace;
  let record = args.record;
  const { columns } = record;
  let estimated = 0;
  const over = () => budget !== undefined && estimated >= budget;
  const counted = (done: TrialDone) => {
    estimated += trialSpend(
      { record: done.record, scores: done.score ? [done.score] : [] },
      record,
    );
  };
  const shown = (done: TrialDone) =>
    progress(context.stderr, record, done, bars.get(done.record.case)?.deciders);
  const trialIn = (n: number, info: CaseInfo, trial: number) => {
    const column = columns[n]!;
    const code = codeFolders[column.folder]!;
    return runTrial(lab, code.folder, info, n, trial, code.envFile, column.params, (input) =>
      reuse.keyOf(n, input),
    );
  };
  for (const { column, trials } of reuse.slots.values()) {
    for (const [i, from] of trials.entries()) reuseTrial(store, record.id, from, column, i + 1);
  }
  if (reuse.regrade) {
    const done = await gradeReused(context, store, reuse.regrade, record.id, lab, budget);
    estimated += done.estimate;
    if (done.stopped) record = { ...record, stopped: "budget" };
  }
  const passes: { cases: CaseInfo[]; trial: number }[] = [];
  if (given.stop) {
    for (const c of selected) {
      for (let trial = 1; trial <= trialsOf(c.name); trial++) passes.push({ cases: [c], trial });
    }
  } else {
    const most = Math.max(...selected.map((c) => trialsOf(c.name)));
    for (let trial = 1; trial <= most; trial++) {
      passes.push({ cases: selected.filter((c) => trialsOf(c.name) >= trial), trial });
    }
  }
  const reusedIn = (name: string, n: number) =>
    reuse.slots.get(slotOf(name, n))?.trials.length ?? 0;
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
      if (await given.stop(record, readTrials(store, record.id))) {
        record = { ...record, stopped: "compare" };
      }
    }
  }
  return record;
}

/**
 * Grades the trials a run reused where a key or grader changed since they were graded, as `score`
 * would, with no question: the run's plan asked. The plan's trials are read as this run's.
 */
async function gradeReused(
  context: Context,
  store: string,
  planned: ScorePlan,
  run: string,
  lab: Pick<TrialLab, "tmp" | "now">,
  budget: number | undefined,
): Promise<ScoreDone> {
  const here = new Map(
    readTrials(store, run)
      .filter((t) => t.record.reused)
      .map((t) => [t.dir, t]),
  );
  const plan = {
    ...planned,
    items: planned.items.map((item) => ({
      ...item,
      trial: here.get(item.trial.dir) ?? item.trial,
    })),
  };
  context.stderr(
    `grading ${plural(plan.items.length, "reused trial")} again: a key or grader changed`,
  );
  return runScore({
    plan,
    tmp: lab.tmp,
    run,
    store,
    env: envOf(context),
    ...(budget !== undefined ? { budget } : {}),
    now: lab.now,
    progress: context.stderr,
  });
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
  for (const { trials } of readableRuns(store, { dataset })) {
    for (const { record: trial, scores } of trials) {
      if (!names.includes(trial.case) || !trial.runId || trial.reused) continue;
      if (trialOutcome(trial, scores).outcome === "errored") continue;
      // The grading the trial was given as it ran, its first score: a judge can cost far more
      // than the workflow it judges.
      const graded = scores.slice(0, 1);
      ms.push(trial.ms + (graded[0]?.entries ?? []).reduce((sum, e) => sum + (e.ms ?? 0), 0));
      if (trial.estimate !== undefined) cost.push(trial.estimate);
      grading.push(gradingSpend(graded));
    }
  }
  const time = median(ms);
  if (time === undefined) return undefined;
  const each = median(cost);
  const grades = median(grading) ?? 0;
  const price =
    each === undefined
      ? grades > 0
        ? `, grading est. ${usd(grades * count)}, the workflow unpriced`
        : ""
      : `, est. ${usd((each + grades) * count)}${grades > 0 ? `, grading ${usd(grades * count)} of it` : ""}`;
  return `from earlier trials: about ${seconds(time * count)}${price}`;
}

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
