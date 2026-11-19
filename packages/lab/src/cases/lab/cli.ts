import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { findConfigFile } from "../../shared/config-file";
import { checkSchema, describeProblems } from "../../shared/validate";
import { type CaseReport, SCORED_KIND, type Scored, ScoredSchema } from "../format/output";
import { LABEL_KIND, type Mark as LabelMark, type RunRecord } from "../format/records";
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
import { runHelper } from "./code-graders";
import {
  askOperator,
  type CasesEnvironment,
  type Context,
  countedGraders,
  datasetGraders,
  envOf,
  externalsOf,
  loadDataset,
  lockHeld,
  type Options,
  relativePaths,
  reportJson,
  runReport,
  tagged,
  tmpOf,
  workspaceOf,
} from "./command-context";
import { criteriaJudge } from "./criteria";
import { type CaseInfo, type DatasetInfo, folderDigest, readCases } from "./dataset";
import { buildCase, clearStale } from "./folders";
import { gitTop } from "./git";
import type { LabGrader } from "./grading";
import { checkEnvFile, type FolderSetup, inspectFolder } from "./inspect";
import { appendLabel, readLabels } from "./labels";
import { loopCommand } from "./loop-command";
import { writeLabels, writeRecords } from "./record-copies";
import { Refusal } from "./refusal";
import { markdownOf, plural, renderCase, usd } from "./report";
import { refuseRetiredCommand, refuseRetiredFlag } from "./retired";
import { run } from "./run-command";
import { barsOf, criteriaCount } from "./runs";
import { newCase } from "./scaffold";
import { describePlan, regradePlan, runScore, type ScoreDone } from "./score";
import {
  awfRunsOf,
  RUN_ID,
  readRunRecord,
  readTrials,
  runIds,
  type StoredTrial,
  takeLock,
  UnreadableRecord,
} from "./store";
import { trialSettingsOf } from "./trial-settings";
import { commandUsage, fullUsage, refuseForeignFlags, refuseNotCommand } from "./usage";
import type { CaseWorkspace } from "./workspace";

function parse(argv: readonly string[]): {
  command?: string;
  names: string[];
  options: Options;
  /** The flags given, each once, as written; `-h` as `--help`. */
  flags: string[];
} {
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
  const flags = new Set<string>();
  const rest = [...argv];
  const value = (flag: string) => {
    const next = rest.shift();
    if (next === undefined || next.startsWith("--")) throw new Refusal(`${flag} needs a value`);
    return next;
  };
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg.startsWith("-")) flags.add(arg === "-h" ? "--help" : arg);
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
  return { ...(command ? { command } : {}), names, options, flags: [...flags] };
}

/** The case kind's command line: `case new`, `run`, `report` and `runs`. */
export async function runCases(
  argv: readonly string[],
  environment: CasesEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr = environment.stderr ?? ((text) => void process.stderr.write(`${text}\n`));
  try {
    const { command, names, options, flags } = parse(argv);
    if (!command) {
      stdout(fullUsage());
      return options.help ? 0 : 2;
    }
    refuseNotCommand(command);
    refuseRetiredCommand(command);
    if (options.help) {
      const own = commandUsage(command);
      if (!own) throw new Refusal(`unknown command ${command}; awf-lab --help lists them`);
      stdout(own);
      return 0;
    }
    refuseForeignFlags(command, flags);
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
        return (await run(context)).exit;
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
        return await loopCommand(context, names);
      default:
        throw new Refusal(`unknown command ${command}; awf-lab --help lists them`);
    }
  } catch (error) {
    if (error instanceof Refusal) {
      stderr(`awf-lab: ${relativePaths(environment.cwd ?? process.cwd(), error.message)}`);
      return 2;
    }
    stderr(`awf-lab: ${(error as Error).message}`);
    return 4;
  }
}

function caseCommand(context: Context, names: readonly string[]): number {
  const [verb, address, ...extra] = names;
  if (verb !== "new") {
    throw new Refusal(`case takes new${verb ? `, not ${verb}` : ""}: case new {dataset}/{case}`);
  }
  if (!address) throw new Refusal("case new needs a {dataset}/{case}");
  if (extra.length > 0) {
    throw new Refusal(
      `case new takes one {dataset}/{case}; got ${extra.length + 1} words: ${[address, ...extra].join(" ")}`,
    );
  }
  const config = findConfigFile(context.cwd, context.options.config);
  const evals = config ? join(config, "..") : join(gitTop(context.cwd) ?? context.cwd, "evals");
  const made = newCase(evals, address);
  for (const file of made.written) context.stdout(`wrote ${relative(context.cwd, file) || file}`);
  context.stdout(`case ${relative(context.cwd, made.caseDir)}: write its key.md and files/`);
  return 0;
}

/** A trial's id, its workflow run's: `20261119T054028Z-c13b6e75`. */
const TRIAL_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$/;

/** The run named, by its id or the last four characters of it, or the newest. */
function chooseRun(workspace: CaseWorkspace, names: readonly string[], command: string): RunRecord {
  if (names.length > 1) {
    throw new Refusal(`${command} takes one run; got ${names.length}: ${names.join(" ")}`);
  }
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
  if (TRIAL_ID.test(given)) {
    throw new Refusal(
      `${given} is a trial's id: ${command} takes a run from awf-lab runs; label and capture take trial ids`,
    );
  }
  if (!RUN_ID.test(given) && !/^[0-9a-f]{4}$/.test(given)) {
    throw new Refusal(
      `${given} is no run: a run is its id, such as 20261117-142233-a3f9, or its last four characters; awf-lab runs lists them`,
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

/** Refuses a lab run's id given where a trial's is wanted, naming where trial ids are listed. */
function refuseLabRun(workspace: CaseWorkspace, given: string, command: string): void {
  const run =
    RUN_ID.test(given) ||
    (/^[0-9a-f]{4}$/.test(given) && runIds(workspace.store).some((id) => id.endsWith(`-${given}`)));
  if (run) {
    throw new Refusal(
      `${given} is a lab run: ${command} takes a trial's id, which report --case {case} lists`,
    );
  }
}

function readRunOrRefuse(workspace: CaseWorkspace, id: string): RunRecord {
  const run = readRunRecord(workspace.store, id);
  if (!run) throw new Refusal(`no run ${id} in ${workspace.store}`);
  return run;
}

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

async function report(context: Context, names: readonly string[]): Promise<number> {
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
    context.stdout(JSON.stringify(report.json(exit), null, 2));
  } else context.stdout(report.text);
  return exit;
}

/**
 * Grades a kept run again, without running a trial: never `env.ts`, the workflow or `observe`.
 * Cheap graders first; a grader workflow is skipped again when the trial still fails a cheap one.
 */
async function score(context: Context, names: readonly string[]): Promise<number> {
  const { options, environment, stderr } = context;
  const workspace = workspaceOf(context);
  const run = chooseRun(workspace, names, "score");
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
        { runner: externalsOf(environment).runner, runRoot: awfRunsOf(workspace.store), now },
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
  const tmp = tmpOf(context);
  const trials = readTrials(workspace.store, run.id);
  const byCase = new Map(cases.map((c) => [c.name, c]));
  const plan = regradePlan({
    trials: options.tags
      ? trials.filter((t) => {
          const info = byCase.get(t.record.case);
          return info !== undefined && tagged(info, options.tags!);
        })
      : trials,
    store: workspace.store,
    info,
    cases,
    graders,
    tmp,
    only: {
      graders: chosen,
      expect: options.grader === undefined && options.judges.length === 0,
    },
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
        env: envOf(context),
        ...(options.budget !== undefined ? { budget: options.budget } : {}),
        now,
        progress: stderr,
      });
    } finally {
      if (workspace.records) writeRecords(workspace.store, workspace.records, run.id);
      lock.release();
    }
  } else stderr(described);
  const rendered = await runReport(context, workspace, {
    info,
    run,
    trials: readTrials(workspace.store, run.id),
    bars: barsOf(info, cases, graders),
    graders,
    criteria: criteriaCount(
      cases,
      run.asked.map((a) => a.case),
    ),
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
      report: rendered.json(exit),
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
        ...(done.estimate > 0 ? [`est. ${usd(done.estimate)}`] : []),
        ...(done.stopped
          ? [`stopped at the budget, ${usd(options.budget!)}: the rest is not graded`]
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
  const [runId, ...extra] = names;
  if (!runId) {
    throw new Refusal(
      "capture needs a trial's id, which report --case {case} lists, or a real run's awf run id",
    );
  }
  if (extra.length > 0) {
    throw new Refusal(`capture takes one id; got ${names.length}: ${names.join(" ")}`);
  }
  if (options.good === (options.needsWork !== undefined)) {
    throw new Refusal(
      options.good
        ? 'capture takes --good or --needs-work "{note}", not both'
        : 'capture needs --good or --needs-work "{note}": how the run went',
    );
  }
  const mark: Mark = options.good
    ? { mark: "good" }
    : { mark: "needs-work", note: options.needsWork! };
  const workspace = workspaceOf(context);
  refuseLabRun(workspace, runId, "capture");
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
  const say = (dir: string, from: string) =>
    context.stdout(
      `wrote ${relative(context.cwd, dir) || dir}, ${from}: its key is a draft to finish`,
    );

  const trial = findTrial(workspace.store, runId);
  if (trial) {
    if (trial.record.dataset !== info.name) {
      throw new Refusal(
        `trial ${runId} is of dataset ${trial.record.dataset}: --dataset ${trial.record.dataset}`,
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
    if (folderDigestOfCase(info, trial.record.case, tmpOf(context)) !== trial.record.input) {
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
      `no trial or run ${runId}: neither a trial in ${workspace.store} nor a run in ${join(workspace.root, ".awf/runs")}`,
    );
  }
  const file = join(info.dir, CAPTURE_FILE);
  if (!existsSync(file)) {
    throw new Refusal(
      `run ${runId} is a real run: ${relative(context.cwd, file) || file} turns one into cases, and ${info.name} has none`,
    );
  }
  const work = mkdtempSync(join(tmpOf(context), "awf-lab-capture-"));
  let answer: { cases?: unknown; error?: string };
  try {
    answer = (await runHelper(
      { mode: "capture", file, input: { run: readRealRun(found), root: workspace.root } },
      {
        root: workspace.root,
        work,
        env: envOf(context),
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
function folderDigestOfCase(info: DatasetInfo, name: string, under: string): string | undefined {
  const tmp = mkdtempSync(join(under, "awf-lab-capture-case-"));
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
  const given = [options.good, options.needsWork !== undefined, options.clear].filter(Boolean);
  if (names.length === 0) {
    throw new Refusal("label needs a trial's id, which report --case {case} lists");
  }
  if (names.length > 1) {
    throw new Refusal(`label takes one trial's id; got ${names.length}: ${names.join(" ")}`);
  }
  if (given.length !== 1) {
    throw new Refusal(
      `label ${given.length === 0 ? "needs" : "takes one of"} --good, --needs-work "{note}" or --clear`,
    );
  }
  const workspace = workspaceOf(context);
  const runId = names[0]!;
  refuseLabRun(workspace, runId, "label");
  const trial = findTrial(workspace.store, runId);
  if (!trial) {
    throw new Refusal(
      `no trial ${runId} in ${workspace.store}; awf-lab report --case {case} lists each trial's id`,
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
