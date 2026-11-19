import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { awfAllowance, waitingOnAllowance } from "../../shared/allowance";
import { awfRunEstimate, processRunner, withoutCallingSession } from "../../shared/runner";
import { checkSchema, describeProblems } from "../../shared/validate";
import { HypothesisSchema } from "../format/loop";
import type { RunRecord } from "../format/records";
import { DEFAULT_PROPOSER } from "../loop/propose.workflow";
import {
  awfReads,
  boxCommand,
  boxProfile,
  hiddenAround,
  hiddenOf,
  MODEL_DOMAINS,
  toolchainOf,
} from "./box";
import type { Context, Options, RunGiven } from "./cli";
import type { ColumnVerdict } from "./compare";
import { type CaseInfo, type DatasetInfo, fileDigest } from "./dataset";
import { gitState } from "./git";
import type { LabGrader } from "./grading";
import { checkEnvFile, inspectFolder } from "./inspect";
import {
  codeOf,
  incumbentOf,
  keepRuns,
  type LoopDeps,
  loopDirOf,
  patchOf,
  readLoop,
  readTries,
  runFinal,
  runLoop,
  type TryRun,
} from "./loop";
import { newestEntries, trialOutcome } from "./outcome";
import { Refusal } from "./refusal";
import { barsOf, type CaseBar } from "./runs";
import { awfRunsOf, newRunId, readRunRecord, readTrials, type StoredTrial } from "./store";
import { definedOf } from "./trial";
import { type CaseWorkspace, inside } from "./workspace";

export const PROPOSER = join(import.meta.dir, "../loop/propose.workflow.ts");

/** What `cli.ts` lends the loop: its `run`, the comparison, and how it opens a workspace. */
export type LoopLends = {
  run: (context: Context, given: RunGiven) => Promise<number>;
  verdictsOf: (
    context: Context,
    workspace: CaseWorkspace,
    info: DatasetInfo,
    run: RunRecord,
    trials: readonly StoredTrial[],
    bars: ReadonlyMap<string, CaseBar>,
  ) => Promise<ColumnVerdict[] | undefined>;
  workspaceOf: (context: Context) => CaseWorkspace;
  /** The dataset's graders, counted, never run: whose numbers a comparison reads. */
  countedGraders: (
    context: Context,
    workspace: CaseWorkspace,
    info: DatasetInfo,
  ) => Promise<readonly Pick<LabGrader, "name" | "onDemand">[]>;
  loadDataset: (
    workspace: CaseWorkspace,
    name?: string,
    holdout?: boolean | "all",
  ) => { info: DatasetInfo; cases: CaseInfo[] };
};

/** The share of a plan window at which a loop waits, unless `--allowance` says. */
const DEFAULT_ALLOWANCE = 90;

/** `loop {name}`: tries, `--final` or `--patch`. */
export async function loopCommand(
  context: Context,
  names: readonly string[],
  lends: LoopLends,
): Promise<number> {
  const { options } = context;
  const [name, ...extra] = names;
  if (!name || extra.length > 0) throw new Refusal("awf-lab loop {name} --budget {usd}");
  // A loop picks its own cases, columns and reuse: these would change what a try runs unseen.
  const foreign = [
    options.tags ? "--tags" : "",
    options.against.length > 0 ? "--against" : "",
    options.vary.length > 0 ? "--vary" : "",
    options.failed ? "--failed" : "",
    options.fresh ? "--fresh" : "",
    options.holdout ? "--holdout" : "",
  ].filter(Boolean);
  if (foreign.length > 0) throw new Refusal(`a loop takes no ${foreign.join(", ")}`);
  const workspace = lends.workspaceOf(context);
  const dir = loopDirOf(workspace.store, name);
  if (options.patch) {
    const kept = incumbentOf(readTries(dir));
    if (!readLoop(dir)) throw new Refusal(`no loop ${name}`);
    if (kept === 0) {
      context.stderr(`loop ${name} kept nothing: no patch`);
      return 1;
    }
    context.stdout(patchOf(codeOf(dir, kept)));
    return 0;
  }
  const started = readLoop(dir);
  const { info, cases } = lends.loadDataset(workspace, started?.dataset ?? options.dataset);
  const { cases: held } = lends.loadDataset(workspace, info.name, true);
  const sandbox = info.dataset.sandbox;
  if (typeof sandbox !== "object" || !("lab" in sandbox)) {
    throw new Refusal(
      `a loop runs code no person wrote: ${info.name}'s dataset.json needs "sandbox": { "lab": "srt" }`,
    );
  }
  const graders = join(info.dir, "graders.ts");
  if (!existsSync(graders)) {
    throw new Refusal(
      `a loop keeps a try only when better: ${info.name} needs compare in graders.ts`,
    );
  }
  const top = workspace.repository ?? workspace.root;
  const bars = barsOf(
    info,
    [...cases, ...held],
    await lends.countedGraders(context, workspace, info),
  );
  const deps = loopDeps(context, lends, { workspace, info, bars, top, dir, name });
  deps.comparison = `graders.ts ${fileDigest(graders).slice(0, 19)}`;

  if (options.final) {
    if (options.budget === undefined) {
      throw new Refusal("a final check spends: --budget {usd} is required");
    }
    const started = readLoop(dir);
    if (started && JSON.stringify([...options.param].sort()) !== JSON.stringify(started.params)) {
      throw new Refusal(
        `loop ${name} runs under --param ${started.params.join(" ") || "none"}: its final check does too`,
      );
    }
    const outcome = await runFinal({ dir, budget: options.budget }, deps);
    context.stdout(outcome.why);
    return outcome.exit;
  }
  if (options.budget === undefined) {
    throw new Refusal("a loop spends until a cap: --budget {usd} is required");
  }
  const state = gitState(workspace.root);
  const outcome = await runLoop(
    {
      name,
      dataset: info.name,
      dir,
      top,
      workspace,
      tuning: options.cases ? cases.filter((c) => options.cases!.includes(c.name)) : cases,
      holdout: held.map((c) => c.name),
      trials: options.trials ?? 1,
      params: options.param,
      rounds: options.rounds ?? 1,
      budget: options.budget,
      ...(options.program ? { program: resolve(context.cwd, options.program) } : {}),
      proposer: options.proposer ?? started?.proposer ?? DEFAULT_PROPOSER,
      from: { path: workspace.root, commit: state.commit, dirty: state.dirty },
    },
    deps,
  );
  context.stdout(`loop ${name}: ${outcome.why}`);
  return outcome.exit;
}

function loopDeps(
  context: Context,
  lends: LoopLends,
  at: {
    workspace: CaseWorkspace;
    info: DatasetInfo;
    bars: ReadonlyMap<string, CaseBar>;
    top: string;
    dir: string;
    name: string;
  },
): LoopDeps & { comparison: string } {
  const { options, environment } = context;
  const { workspace, info, bars } = at;
  const runner = environment.runner ?? processRunner();
  const env = environment.env ?? process.env;
  const limit = options.allowance ?? DEFAULT_ALLOWANCE;
  const allowance = environment.allowance ?? (environment.runner ? undefined : awfAllowance);
  // The agents a loop draws on, as far as it can name them: the proposer, and any parameter
  // value that is a harness/model.
  const named = () => [
    readLoop(at.dir)?.proposer ?? options.proposer ?? DEFAULT_PROPOSER,
    ...options.param.map((p) => p.slice(p.indexOf("=") + 1)),
  ];
  const wait =
    allowance && limit !== "off"
      ? waitingOnAllowance(async () => undefined, allowance, { limit, log: context.stderr })
      : undefined;
  return {
    comparison: "",
    log: (line) => context.stderr(line),
    now: environment.now ?? (() => new Date()),
    async waitForAllowance() {
      if (wait) await wait({ argv: named() });
    },
    spentIn(runIds) {
      return runIds.reduce((sum, id) => sum + spendOf(readTrials(workspace.store, id)), 0);
    },
    async runFolders({ folders, order, budget, stopOnVerdict, holdout, started }) {
      let runId: string | undefined;
      const scoped: Context = {
        ...context,
        options: {
          ...options,
          dataset: info.name,
          yes: true,
          fresh: false,
          failed: false,
          holdout: holdout ?? false,
          against: [],
          vary: [],
          json: false,
          dryRun: false,
          ...(Number.isFinite(budget) ? { budget: Math.max(budget, 0.01) } : { budget: undefined }),
        } as Options,
      };
      const given: RunGiven = {
        folders,
        order,
        report: false,
        started: (id) => {
          runId = id;
          started?.(id);
        },
        ...(stopOnVerdict
          ? {
              stop: async (run, trials) => {
                const verdict = (
                  await lends.verdictsOf(
                    scoped,
                    workspace,
                    info,
                    run,
                    bothRan(trials, folders.length),
                    bars,
                  )
                )?.[0];
                return verdict !== undefined && "verdict" in verdict && verdict.verdict.stop;
              },
            }
          : {}),
      };
      await lends.run(scoped, given);
      if (!runId) throw new Error("the try's run never started");
      const record = readRunRecord(workspace.store, runId)!;
      // Decided by nothing: the loop stops undecided, and resumes with this try.
      if (record.broke) throw new Error(`the lab broke during run ${runId}: ${record.broke}`);
      const trials = readTrials(workspace.store, runId);
      const verdicts =
        folders.length > 1
          ? await lends.verdictsOf(
              scoped,
              workspace,
              info,
              record,
              bothRan(trials, folders.length),
              bars,
            )
          : undefined;
      const first = verdicts?.[0];
      const result: TryRun = {
        runId,
        ...(record.stopped ? { stopped: record.stopped } : {}),
        ...(first
          ? {
              verdict:
                "verdict" in first
                  ? {
                      verdict: first.verdict.verdict,
                      stop: first.verdict.stop,
                      reason: first.verdict.reason,
                    }
                  : { error: first.error },
            }
          : {}),
        spend: spendOf(trials),
      };
      return result;
    },
    feedback(runId, column) {
      return readTrials(workspace.store, runId)
        .filter((t) => t.record.column === column)
        .map(({ record, scores }) => ({
          case: record.case,
          trial: record.trial,
          outcome: trialOutcome(record, scores).outcome,
          ...(record.facts ? { facts: record.facts } : {}),
          ...(record.workflowError ? { workflowError: record.workflowError } : {}),
          grades: newestEntries(scores).map((e) => ({
            grader: e.grader,
            ...(e.verdict ? { verdict: e.verdict } : {}),
            ...(e.numbers ? { numbers: e.numbers } : {}),
            ...(e.reasons ? { reasons: e.reasons } : {}),
            ...(e.parts
              ? { parts: e.parts.map((p) => ({ about: p.about, label: p.label, why: p.why })) }
              : {}),
            ...(e.errored ? { errored: e.errored } : {}),
          })),
        }));
    },
    async propose({ tryDir, code, bundle, proposer }) {
      // The copy's own install, which its box reads, not your checkout's.
      const copyRoot = join(code, workspace.root.slice(at.top.length));
      const folder = await (environment.inspect ?? inspectFolder)(
        copyRoot,
        checkEnvFile(join(copyRoot, info.dir.slice(workspace.root.length))),
      );
      const id = newRunId((environment.now ?? (() => new Date()))());
      const own = join(tryDir, "proposer");
      const runRoot = join(own, "runs");
      const home = join(own, "home");
      const control = join(
        existsSync("/private/tmp") ? "/private/tmp" : "/tmp",
        `awf-lab-${id.slice(-8)}`,
      );
      for (const d of [runRoot, join(home, "tmp"), control]) mkdirSync(d, { recursive: true });
      const trialFile = join(own, "trial.jsonl");
      writeFileSync(trialFile, "");
      const path = [folder.bin, env.PATH].filter(Boolean).join(":");
      const harness = proposer.slice(0, proposer.indexOf("/"));
      const lab = realpathSync(join(import.meta.dir, "../../.."));
      const profile = boxProfile(
        {
          root: lab,
          caseDir: bundle,
          scratch: code,
          runRoot,
          home,
          trialFile,
          control,
          toolchain: [...toolchainOf(code, path), ...awfReads(folder.awf)],
          // The store and the lab's home whole but this try's folder, where the proposer works.
          hidden: [
            ...hiddenOf(code, workspace).filter(
              (path) => path !== workspace.store && path !== workspace.labHome,
            ),
            ...hiddenAround(workspace.labHome, [tryDir]),
            // A store set outside the lab's home, as awf-lab.json's store may be.
            ...(inside(workspace.labHome, workspace.store)
              ? []
              : hiddenAround(workspace.store, [tryDir])),
          ],
          readOnly: [join(code, workspace.evals.slice(at.top.length + 1))],
          reads: [tryDir],
        },
        [...(MODEL_DOMAINS[harness] ?? [])],
      );
      try {
        const result = await runner({
          workflow: PROPOSER,
          cwd: tryDir,
          timeout: "30m",
          argv: ["--runtime", proposer],
          runRoot,
          id,
          awf: { bin: folder.awf.bin, dir: folder.awf.dir },
          quiet: true,
          env: {
            ...definedOf(withoutCallingSession(env)),
            PATH: path,
            HOME: home,
            TMPDIR: join(home, "tmp"),
            CLAUDE_CODE_TMPDIR: join(home, "tmp"),
            TMPPREFIX: join(home, "tmp", "zsh"),
            AWF_CONTROL_ROOT: control,
          },
          boxed: true,
          box: boxCommand(profile, join(own, "box.json")),
        });
        keepRuns(runRoot, awfRunsOf(workspace.store));
        const record = result.record;
        // A proposer cut short prints no record; its folder still says what its agent spent.
        const unrecorded =
          record || !(environment.estimate ?? !environment.runner)
            ? undefined
            : await (environment.estimate ?? awfRunEstimate)(
                folder.awf,
                runRoot,
                id,
                definedOf(withoutCallingSession(env)),
              );
        const spend = record?.accounting.totals.estimate ?? unrecorded ?? 0;
        if (record?.outcome !== "completed") {
          return {
            spend,
            ...(record ? { runId: record.runId } : {}),
            why: `the proposer's run ${record?.outcome ?? "printed no record"}: ${
              (record && "reason" in record ? record.reason : undefined) ??
              result.unread ??
              result.stderr.trim().split("\n").at(-1) ??
              ""
            }`,
          };
        }
        const checked = checkSchema(HypothesisSchema, record.value);
        if (!checked.ok) {
          return {
            spend,
            runId: record.runId,
            why: describeProblems("the proposer's answer", checked.problems),
          };
        }
        return { spend, runId: record.runId, hypothesis: checked.value };
      } finally {
        rmSync(control, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The trials of the cases every column has run: a try's run holds the incumbent's reused trials of
 * every case from its start, and a comparison weighs only what both have.
 */
function bothRan(trials: readonly StoredTrial[], columns: number): StoredTrial[] {
  const ran = new Map<string, Set<number>>();
  for (const t of trials) {
    const seen = ran.get(t.record.case) ?? new Set<number>();
    seen.add(t.record.column);
    ran.set(t.record.case, seen);
  }
  return trials.filter((t) => (ran.get(t.record.case)?.size ?? 0) === columns);
}

/** What a run's own trials and their grades are estimated at; reused ones were counted where they ran. */
function spendOf(trials: readonly StoredTrial[]): number {
  return trials
    .filter((t) => !t.record.reused)
    .reduce(
      (sum, t) =>
        sum +
        (t.record.estimate ?? 0) +
        t.scores.flatMap((s) => s.entries).reduce((n, e) => n + (e.estimate ?? 0), 0),
      0,
    );
}
