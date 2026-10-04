import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AttemptRecord, StageRecord } from "@agentswf/contract/records";
import type { Ending, ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { refusal } from "./refusal";
import type { RunCommand } from "./run-command";
import {
  checkContinue,
  checkFree,
  idProblem,
  isLive,
  openRun,
  type Run,
  RunRefused,
  readAttempts,
  readStageRecords,
} from "./runs";
import type { WorkflowStopped } from "./stopped";
import { assertJsonValue, type LoadedWorkflow } from "./workflow-loader";

export type PreparedRun = {
  args: JsonValue;
  /** A new run's id, from `--id` or the workflow's `id(args)`; absent for one to generate. */
  id?: string;
  /** The run `--continue` names, its earlier attempts, and what to warn of before it goes on. */
  continued?: { run: Run; attempts: AttemptRecord[]; warnings: string[] };
};

/**
 * The workflow's arguments, and the run `--continue` names, whose recorded argv is prepared again
 * by the code as it is now. A new run is claimed after, by its caller.
 */
export async function prepareRun(
  command: RunCommand,
  loaded: LoadedWorkflow,
  now: number,
): Promise<PreparedRun> {
  const { executable, file } = loaded;
  const { meta } = executable.definition;
  const prepare = (argv: readonly string[], cwd: string) => {
    const args = executable.prepare({ argv, cwd });
    assertJsonValue(args, `${meta.name} arguments`);
    return args;
  };
  if (command.continueId === undefined) {
    const args = prepare(command.workflowArgs, command.cwd);
    const id = command.id ?? derivedId(executable, args);
    if (id !== undefined) await checkFree(command.runRoot, meta.name, id);
    return { args, ...(id === undefined ? {} : { id }) };
  }
  const run = await openRun(command.runRoot, meta.name, command.continueId);
  checkContinue(run, {
    argv: command.workflowArgs,
    ...(command.cwdGiven ? { cwd: command.cwd } : {}),
    ...(command.sandbox === undefined ? {} : { sandbox: command.sandbox }),
  });
  const { id, argv, cwd } = run.record;
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new RunRefused(`${id} works in ${cwd}, which is no longer a directory`);
  }
  let args: JsonValue;
  try {
    args = prepare(argv, cwd);
  } catch (error) {
    throw new RunRefused(
      `the recorded argv of ${id} no longer parses with ${file}: ${messageOf(error)}; start a new run`,
    );
  }
  const attempts = await readAttempts(run);
  const records = await readStageRecords(run.dir);
  // The claim refuses it too; this says so before `--here` opens a tab, or `--session` waits.
  const refused = refusal(id, attempts, {
    fromStage: command.fromStage !== undefined,
    stages: [...records.keys()],
    listed: listRecorded(records, now),
    live: (attempt) => isLive(attempt),
  });
  if (refused) throw new RunRefused(refused);
  const { fromStage } = command;
  // Warned of here, before anything runs.
  const unrecorded =
    fromStage !== undefined && !records.has(fromStage)
      ? [`awf: nothing is recorded for ${fromStage}; the attempt stops if it never reaches it`]
      : [];
  return { args, continued: { run, attempts, warnings: unrecorded } };
}

/** The id the workflow's `id(args)` gives a new run, checked; undefined when it has none. */
function derivedId(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  args: JsonValue,
): string | undefined {
  if (!executable.id) return undefined;
  let id: unknown;
  try {
    id = executable.id(args);
  } catch (error) {
    throw new RunRefused(`the workflow's id(args) failed: ${messageOf(error)}; --id gives one`);
  }
  const problem =
    typeof id === "string" ? idProblem(id) : `it returned a ${typeof id}, not a string`;
  if (problem) throw new RunRefused(`the workflow's id(args): ${problem}; --id gives one`);
  return id as string;
}

/** A run's stage records, a line each in the order they began: summary, attempt, and how long ago. */
function listRecorded(recorded: ReadonlyMap<string, StageRecord>, now: number): string[] {
  const records = [...recorded.values()].sort((a, b) => a.started.localeCompare(b.started));
  const name = Math.max(0, ...records.map((record) => record.stage.length));
  const summary = Math.max(0, ...records.map((record) => record.summary?.length ?? 0));
  return records.map((record) =>
    [
      `  ${record.stage.padEnd(name)}`,
      ...(summary > 0 ? [(record.summary ?? "").padEnd(summary)] : []),
      [
        ...(record.outcome === "succeeded" ? [] : [record.outcome]),
        `attempt ${record.attempt}`,
        ago(now - Date.parse(record.ended)),
      ].join(" · "),
    ].join("   "),
  );
}

function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "at an unknown time";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A run's Herdr workspace, which names the attempt: a dead one's may still be open. */
export function workspaceLabel(workflow: string, id: string, attempt: number): string {
  return `awf ${workflow} ${id} #${attempt}`;
}

/**
 * The command that goes on from an attempt that didn't complete: the same file and run root, and
 * `--from-stage` when a plain continue would stop at the same record again.
 */
export function continueCommand(
  command: RunCommand,
  id: string,
  stop: WorkflowStopped | undefined,
): string {
  return [
    "awf",
    "run",
    ...(command.runRootGiven ? ["--run-root", command.runRoot] : []),
    ...(command.cwdGiven ? ["--cwd", command.cwd] : []),
    relativeTo(command.shellCwd, command.workflowFile),
    "--continue",
    id,
    ...(stop?.redo && stop.stage !== undefined ? ["--from-stage", stop.stage] : []),
  ]
    .map(shellWord)
    .join(" ");
}

/** A path as typed when it is under `cwd`, absolute otherwise, so it works from elsewhere too. */
function relativeTo(cwd: string, file: string): string {
  const absolute = resolve(cwd, file);
  const inside = relative(cwd, absolute);
  return inside.startsWith("..") ? absolute : file;
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * A plain continue that ran no stage and stopped between stages as the attempt before did: the
 * check on a reused stage's value belongs inside that stage, which a continue would redo.
 */
export function sameStop(
  ending: Ending<JsonValue>,
  earlier: readonly AttemptRecord[],
): string | undefined {
  if (ending.kind !== "stopped" || ending.stage !== undefined) return undefined;
  const reused = ending.stages.at(-1)?.stage;
  // No stage ran, and one was reused: its value is what the check between stages saw.
  if (reused === undefined || ending.stages.some((entered) => entered.source === "ran")) {
    return undefined;
  }
  const before = earlier.at(-1);
  if (
    before?.outcome !== "stopped" ||
    before.stage !== undefined ||
    before.reason !== ending.reason
  ) {
    return undefined;
  }
  return `the same stop as attempt ${before.n}; if a stage's value caused it, --from-stage ${reused}, and move the check into that stage`;
}
