import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runLogLine, type SandboxRecord } from "@agentswf/contract/records";
import { type AwfBin, loginRefused, type Runner, withoutCallingSession } from "../../shared/runner";
import {
  type Errored,
  type Params,
  SCORE_KIND,
  type ScoreRecord,
  TRIAL_KIND,
  type TrialRecord,
} from "../format/records";
import { TRIAL_ENV } from "../format/trial-env";
import { blame, readTrialLines } from "./blame";
import {
  awfReads,
  type BoxProfile,
  boxCommand,
  boxNetwork,
  boxProfile,
  boxReach,
  hiddenOf,
  toolchainOf,
} from "./box";
import { type CaseInfo, type DatasetInfo, folderDigest } from "./dataset";
import {
  buildCase,
  keepFiles,
  makeTrialFolders,
  type Needle,
  searchFolder,
  searchText,
} from "./folders";
import { decidersOf, gradeTrial, type LabGrader } from "./grading";
import type { FolderSetup } from "./inspect";
import { checkReach, type OpenedAgent } from "./reach";
import {
  appendScore,
  awfRunsOf,
  keepInput,
  newRunId,
  trialDirOf,
  trialFileOf,
  writeTrial,
} from "./store";
import { backstopOf, trialSettingsOf } from "./trial-settings";
import type { CaseWorkspace } from "./workspace";

export type TrialLab = {
  workspace: CaseWorkspace;
  dataset: DatasetInfo;
  envFile: string;
  run: string;
  runner: Runner;
  /** Everything `awf logs` has for a trial's run, or why it couldn't be read whole. */
  logs: (
    awf: AwfBin,
    runRoot: string,
    ref: string,
    env: Record<string, string>,
  ) => Promise<{ text: string } | { unread: string }>;
  /** Where trial folders are made: the system's temporary folder. */
  tmp: string;
  /** The lab's environment, which every trial starts from. */
  env: Readonly<Record<string, string | undefined>>;
  graders: readonly LabGrader[];
  now: () => Date;
};

export type TrialDone = { record: TrialRecord; score?: ScoreRecord; dir: string };

/**
 * One trial: the case folder built without the key, the marker looked for, the folder's own `awf`
 * run on `env.ts`, its ending blamed, its agents' reach checked, the marker looked for again, the
 * facts graded; then both folders deleted.
 */
export async function runTrial(
  lab: TrialLab,
  folder: FolderSetup,
  info: CaseInfo,
  column: number,
  trial: number,
  /** The column's `env.ts`: your checkout's, or the same file in a folder `--against` names. */
  envFile: string = lab.envFile,
  /** The column's parameters. */
  params: Params = {},
  /** The trial's reuse key, from its built case's digest; absent, never reused. */
  reuseOf: (input: string) => string | undefined = () => undefined,
): Promise<TrialDone> {
  const { workspace, dataset } = lab;
  const started = Date.now();
  const dir = trialDirOf(workspace.store, lab.run, info.name, column, trial);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const folders = makeTrialFolders(lab.tmp, lab.run);
  // In the lab's box, everything the trial's process writes is in its own folder: the box denies
  // the home folder, so `~/.awf/lab` too.
  const boxed = dataset.dataset.sandbox !== "workflow";
  const trialFile = boxed ? join(folders.parent, "trial.jsonl") : trialFileOf(workspace.labHome);
  try {
    buildCase(dataset.dir, info, folders.dir);
    const input = folderDigest(folders.dir);
    keepInput(workspace.store, input, folders.dir);
    const reuse = reuseOf(input);
    const needle: Needle = { marker: info.key.marker, keyFiles: info.keyFiles };
    const base: TrialRecord = {
      kind: TRIAL_KIND,
      run: lab.run,
      dataset: dataset.name,
      case: info.name,
      column,
      trial,
      params,
      ...(reuse ? { reuse } : {}),
      awf: { bin: folder.awf.bin, version: folder.version },
      input,
      sandbox: boxed ? "lab" : "workflow",
      agentReach: dataset.dataset.agentReach,
      models: [],
      at: lab.now().toISOString(),
      ms: 0,
      unused: [],
      refused: [],
      kept: [],
      leaked: false,
    };
    if (searchFolder(folders.dir, needle, "the case folder").length > 0) {
      const record = { ...base, leaked: true, ms: Date.now() - started };
      writeTrial(dir, record);
      return { record, dir };
    }

    mkdirSync(dirname(trialFile), { recursive: true });
    writeFileSync(trialFile, "");
    const settings = trialSettingsOf(dataset.name, dataset.dataset, dataset.dir);
    const id = newRunId(lab.now());
    const storeRuns = awfRunsOf(workspace.store);
    const runRoot = boxed ? join(folders.parent, "runs") : storeRuns;
    const home = join(folders.parent, "home");
    // `/private/tmp` on macOS: the box denies `/tmp`, the link, and allows only the real path.
    const control = join(
      existsSync("/private/tmp") ? "/private/tmp" : "/tmp",
      `awf-lab-${id.slice(-8)}`,
    );
    let box: { command: string[]; profile: BoxProfile } | undefined;
    if (boxed) {
      mkdirSync(runRoot, { recursive: true });
      mkdirSync(join(home, "tmp"), { recursive: true });
      // Short, as the engine's sockets need: under `/tmp`, the trial's own, removed after.
      mkdirSync(control, { recursive: true });
      const path = [folder.bin, lab.env.PATH].filter(Boolean).join(":");
      const profile = boxProfile(
        {
          root: folder.root,
          caseDir: folders.dir,
          scratch: folders.scratch,
          runRoot,
          home,
          trialFile,
          control,
          toolchain: [...toolchainOf(folder.root, path), ...awfReads(folder.awf)],
          hidden: hiddenOf(folder.root, workspace),
        },
        boxNetwork(dataset.dataset.agentReach, settings.realHosts),
      );
      box = { command: boxCommand(profile, join(folders.parent, "box.json")), profile };
    }
    const env: Record<string, string> = {
      ...definedOf(withoutCallingSession(lab.env)),
      PATH: [folder.bin, lab.env.PATH].filter(Boolean).join(":"),
      [TRIAL_ENV.case]: folders.dir,
      [TRIAL_ENV.trial]: trialFile,
      [TRIAL_ENV.scratch]: folders.scratch,
      [TRIAL_ENV.root]: folder.root,
      [TRIAL_ENV.settings]: JSON.stringify(settings),
      [TRIAL_ENV.params]: JSON.stringify(params),
      // A fresh home: the operator's holds harness state, and transcripts that can hold a key.
      // Harnesses that make their own folder under `/tmp` are pointed at the box's.
      ...(boxed
        ? {
            HOME: home,
            TMPDIR: join(home, "tmp"),
            CLAUDE_CODE_TMPDIR: join(home, "tmp"),
            // zsh makes a here-document's file under `/tmp` unless told otherwise.
            TMPPREFIX: join(home, "tmp", "zsh"),
            AWF_CONTROL_ROOT: control,
          }
        : {}),
    };
    const result = await lab.runner({
      workflow: envFile,
      cwd: folders.scratch,
      timeout: backstopOf(settings),
      argv: [],
      runRoot,
      id,
      awf: folder.awf,
      quiet: true,
      env,
      ...(box ? { boxed: true as const, box: box.command } : {}),
    });
    // The box's run records move into the store, where `awf logs` and history find them.
    if (boxed && existsSync(runRoot)) cpSync(runRoot, storeRuns, { recursive: true });
    if (boxed) rmSync(control, { recursive: true, force: true });
    // The lab's own failures to read what the trial left: its result says nothing of the workflow.
    const unread: string[] = [];
    if (result.unread) unread.push(result.unread);
    const trialText = readFileSync(trialFile, "utf8");
    writeFileSync(join(dir, "trial.jsonl"), trialText);
    const { lines, bad } = readTrialLines(trialText);
    if (bad > 0) unread.push(`${bad} line${bad === 1 ? "" : "s"} of the trial file fit no shape`);
    const run = result.record;
    const blamed = blame(lines, {
      ...(run ? { outcome: run.outcome } : {}),
      ...(run && run.outcome !== "completed" ? { reason: run.reason } : {}),
      ...(run?.outcome === "completed" ? { value: run.value } : {}),
      stderr: result.stderr,
      loginRefused: run !== undefined && loginRefused(run),
    });

    const boxedDir = run?.artifacts?.startsWith(runRoot)
      ? join(storeRuns, run.artifacts.slice(runRoot.length))
      : undefined;
    const runDir = boxed
      ? (boxedDir ?? findRunDir(storeRuns, id))
      : (run?.artifacts ?? findRunDir(runRoot, id));
    const reach = box
      ? boxReach(box.profile, runDir ? readAgents(runDir).opened.map((a) => a.agent) : [])
      : runDir
        ? checkReach({
            ...readAgents(runDir),
            sandboxes: sandboxesOf(runDir, run?.sandboxes),
            agentReach: dataset.dataset.agentReach,
          })
        : undefined;

    const kept = keepFiles(folders.scratch, dataset.dataset.keep ?? [], join(dir, "kept"));
    const ref = run?.ref ?? (run ? `${run.workflow.name}/${run.runId}` : undefined);
    const shown = JSON.stringify({
      value: run?.outcome === "completed" ? run.value : null,
      facts: blamed.facts ?? null,
      result: blamed.result ?? null,
    });
    const logs = ref ? await lab.logs(folder.awf, storeRuns, ref, env) : undefined;
    if (logs && "unread" in logs) unread.push(logs.unread);
    if (run && !runDir) unread.push(`no folder for run ${run.runId} under ${runRoot}`);
    const leaks = [
      ...searchFolder(folders.scratch, needle, "the scratch folder"),
      ...searchText(shown, needle, "the result"),
      ...(logs && "text" in logs ? searchText(logs.text, needle, "the run's logs") : []),
      ...(runDir ? searchFolder(runDir, needle, "the run's records") : []),
    ];

    let errored: Errored | undefined =
      (unread.length > 0
        ? { by: "lab" as const, phase: "after" as const, reason: unread.join("; ") }
        : undefined) ??
      blamed.errored ??
      (reach && !reach.ok
        ? {
            by: "dataset" as const,
            phase: "after" as const,
            code: "reach" as const,
            reason: reach.problems[0]!,
          }
        : undefined);
    const accounting = run?.accounting;
    const record: TrialRecord = {
      ...base,
      ...(blamed.workflow ? { workflow: blamed.workflow } : {}),
      ...(run ? { runId: run.runId, runOutcome: run.outcome } : {}),
      ...(run && run.outcome !== "completed" ? { runReason: run.reason } : {}),
      models: accounting ? accounting.byModel.map((m) => m.model) : [],
      ms: accounting?.wallMs ?? result.ms,
      ...(accounting?.totals.estimate !== undefined
        ? { estimate: accounting.totals.estimate }
        : {}),
      ...(accounting
        ? {
            known: accounting.totals.known,
            priced: accounting.totals.priced,
            agents: accounting.totals.agents,
          }
        : {}),
      ...(blamed.result !== undefined ? { result: blamed.result } : {}),
      ...(blamed.facts ? { facts: blamed.facts } : {}),
      ...(blamed.stages ? { stages: blamed.stages } : {}),
      ...stageTimes(run?.stages, blamed.given),
      ...(blamed.given ? { given: blamed.given } : {}),
      ...(blamed.until ? { until: blamed.until } : {}),
      ...(blamed.neverReached ? { neverReached: blamed.neverReached } : {}),
      unused: blamed.unused,
      refused: blamed.refused,
      kept,
      leaked: leaks.length > 0,
      ...(reach ? { reach } : {}),
      ...(blamed.stopped !== undefined ? { stopped: blamed.stopped } : {}),
      ...(blamed.workflowError !== undefined ? { workflowError: blamed.workflowError } : {}),
    };

    let score: ScoreRecord | undefined;
    const gradable =
      !record.leaked && !errored && !record.workflowError && record.stopped === undefined;
    if (gradable && !info.key.draft) {
      const graded = await gradeTrial({
        info,
        facts: record.facts ?? {},
        stages: record.stages ?? {},
        result: record.result ?? null,
        caseDir: folders.dir,
        scratch: folders.scratch,
        kept: join(dir, "kept"),
        work: folders.parent,
        env: definedOf(withoutCallingSession(lab.env)),
        params,
        expect: Object.keys(info.key.expect ?? {}).length > 0,
        graders: lab.graders.filter((g) => !g.onDemand),
        deciders: decidersOf(info.key, lab.graders),
      });
      if ("errored" in graded) {
        errored = {
          by: "dataset",
          phase: "observe",
          ...(graded.errored.code ? { code: graded.errored.code } : {}),
          reason: graded.errored.reason,
        };
      } else if (graded.entries.length > 0) {
        score = { kind: SCORE_KIND, at: lab.now().toISOString(), entries: graded.entries };
      }
    }
    const final = { ...record, ...(errored ? { errored } : {}) };
    writeTrial(dir, final);
    if (score) appendScore(dir, score);
    return { record: final, ...(score ? { score } : {}), dir };
  } finally {
    rmSync(folders.parent, { recursive: true, force: true });
    rmSync(trialFile, { force: true });
  }
}

/** How long each stage the run ran took; a stage given or reused ran no work of its own. */
function stageTimes(
  stages: readonly { stage: string; source: string; spanMs: number; provided?: true }[] | undefined,
  given: readonly string[] = [],
): { stageMs?: Record<string, number> } {
  // A stage the case gave ran through the engine too, its work only handing the value back.
  const ran = (stages ?? []).filter(
    (s) => s.source === "ran" && !s.provided && !given.includes(s.stage),
  );
  if (ran.length === 0) return {};
  return { stageMs: Object.fromEntries(ran.map((s) => [s.stage, s.spanMs])) };
}

export function definedOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function findRunDir(runRoot: string, id: string): string | undefined {
  if (!existsSync(runRoot)) return undefined;
  for (const path of new Bun.Glob(`*/${id}`).scanSync({ cwd: runRoot, onlyFiles: false })) {
    return join(runRoot, path);
  }
  return undefined;
}

function jsonLines(file: string): object[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value as object] : [];
      } catch {
        return [];
      }
    });
}

/** The agents a run opened, and every agent its sessions and turns name. */
function readAgents(runDir: string): { opened: OpenedAgent[]; named: string[] } {
  const opened: OpenedAgent[] = [];
  const named: string[] = [];
  for (const raw of jsonLines(join(runDir, "log.jsonl"))) {
    const line = runLogLine(raw);
    if (!line) continue;
    if (line.kind === "agent-opened") {
      if (line.caller) continue;
      opened.push({
        agent: line.agent,
        harness: line.harness,
        ...(line.sandbox ? { sandbox: line.sandbox } : {}),
        ...(line.domains ? { domains: line.domains } : {}),
      });
    } else if (line.kind === "turn" || line.kind === "compact") {
      named.push(line.agent);
    }
  }
  for (const raw of jsonLines(join(runDir, "run.jsonl"))) {
    const line = raw as { kind?: unknown; agent?: unknown };
    if (line.kind === "session" && typeof line.agent === "string") named.push(line.agent);
  }
  return { opened, named };
}

/** The run record's sandboxes, and any its `sandbox-opened` lines have that it lacks. */
function sandboxesOf(
  runDir: string,
  recorded: readonly SandboxRecord[] | undefined,
): Pick<SandboxRecord, "key" | "provider" | "spec">[] {
  const byKey = new Map<string, Pick<SandboxRecord, "key" | "provider" | "spec">>();
  for (const raw of jsonLines(join(runDir, "log.jsonl"))) {
    const line = runLogLine(raw);
    if (line?.kind === "sandbox-opened") byKey.set(line.key, line);
  }
  for (const sandbox of recorded ?? []) byKey.set(sandbox.key, sandbox);
  return [...byKey.values()];
}
