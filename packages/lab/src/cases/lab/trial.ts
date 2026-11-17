import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runLogLine, type SandboxRecord } from "@agentswf/contract/records";
import { type AwfBin, loginRefused, type Runner, withoutCallingSession } from "../../shared/runner";
import {
  type Errored,
  SCORE_KIND,
  type ScoreRecord,
  TRIAL_KIND,
  type TrialRecord,
} from "../format/records";
import { TRIAL_ENV } from "../format/trial-env";
import { blame, readTrialLines } from "./blame";
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
import { appendScore, awfRunsOf, newRunId, trialDirOf, trialFileOf, writeTrial } from "./store";
import { backstopOf, trialSettingsOf } from "./trial-settings";
import type { CaseWorkspace } from "./workspace";

export type TrialLab = {
  workspace: CaseWorkspace;
  dataset: DatasetInfo;
  envFile: string;
  run: number;
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
): Promise<TrialDone> {
  const { workspace, dataset } = lab;
  const started = Date.now();
  const dir = trialDirOf(workspace.store, lab.run, info.name, column, trial);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const folders = makeTrialFolders(lab.tmp, lab.run);
  const trialFile = trialFileOf(workspace.labHome);
  try {
    buildCase(dataset.dir, info, folders.dir);
    const input = folderDigest(folders.dir);
    cpSync(folders.dir, join(dir, "input"), { recursive: true, verbatimSymlinks: true });
    const needle: Needle = { marker: info.key.marker, keyFiles: info.keyFiles };
    const base: TrialRecord = {
      kind: TRIAL_KIND,
      run: lab.run,
      dataset: dataset.name,
      case: info.name,
      column,
      trial,
      awf: { bin: folder.awf.bin, version: folder.version },
      input,
      sandbox: "workflow",
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
    const runRoot = awfRunsOf(workspace.store);
    const env: Record<string, string> = {
      ...definedOf(withoutCallingSession(lab.env)),
      PATH: [folder.bin, lab.env.PATH].filter(Boolean).join(":"),
      [TRIAL_ENV.case]: folders.dir,
      [TRIAL_ENV.trial]: trialFile,
      [TRIAL_ENV.scratch]: folders.scratch,
      [TRIAL_ENV.root]: folder.root,
      [TRIAL_ENV.settings]: JSON.stringify(settings),
    };
    const result = await lab.runner({
      workflow: lab.envFile,
      cwd: folders.scratch,
      timeout: backstopOf(settings),
      argv: [],
      runRoot,
      id,
      awf: folder.awf,
      quiet: true,
      env,
    });
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

    const runDir = run?.artifacts ?? findRunDir(runRoot, id);
    const reach = runDir
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
    const logs = ref ? await lab.logs(folder.awf, runRoot, ref, env) : undefined;
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
        params: {},
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

function definedOf(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
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
