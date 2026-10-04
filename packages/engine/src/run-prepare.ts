import { statSync } from "node:fs";
import type { AttemptRecord, StageRecord } from "@agentswf/contract/records";
import type { ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import { pathFrom } from "./display-path";
import { ago } from "./duration";
import { messageOf } from "./errors";
import type { RunCommand } from "./run-command";
import {
  type Attempt,
  type AttemptRefusal,
  attemptRefusal,
  checkContinue,
  checkFree,
  claimAttempt,
  idProblem,
  openRun,
  type Run,
  RunRefused,
  readAttempts,
  readStageRecords,
  readTurns,
} from "./runs";
import type { WorkflowStopped } from "./stopped";
import { assertJsonValue, type LoadedWorkflow, loadWorkflowFile } from "./workflow-loader";

export type PreparedRun = {
  args: JsonValue;
  /** A new run's id, from `--id` or the workflow's `id(args)`; absent for one to generate. */
  id?: string;
  /** The run `--continue` names, its earlier attempts, and what to warn of before it goes on. */
  continued?: { run: Run; attempts: AttemptRecord[]; warnings: string[] };
};

/**
 * The command's workflow loaded and its run prepared, or why not, as awf says it: in the shell that
 * typed the command, before anything starts.
 */
export async function loadAndPrepare(
  command: RunCommand,
  now: number,
): Promise<{ loaded: LoadedWorkflow; prepared: PreparedRun } | { refused: string }> {
  let loaded: LoadedWorkflow;
  try {
    loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
  } catch (error) {
    return { refused: `load: ${messageOf(error)}` };
  }
  try {
    return { loaded, prepared: await prepareRun(command, loaded, now) };
  } catch (error) {
    return { refused: `${error instanceof RunRefused ? "" : "prepare: "}${messageOf(error)}` };
  }
}

/**
 * The workflow's arguments, and the run `--continue` names, whose recorded argv is prepared again
 * by the code as it is now. A new run is claimed after, by its caller.
 */
async function prepareRun(
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
  const refused = attemptRefusal(attempts, records, { fromStage: command.fromStage !== undefined });
  if (refused) throw new RunRefused(refusalMessage(id, refused, now));
  const { fromStage } = command;
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

/** Why a run takes no attempt now, as awf says it, at time `now`. */
function refusalMessage(id: string, refusal: AttemptRefusal, now: number): string {
  if (refusal.kind === "running") {
    return `attempt ${refusal.attempt.attempt} of ${id} is still running, as process ${refusal.attempt.pid}`;
  }
  if (refusal.stages.length === 0) return `${id} completed; there is nothing to continue`;
  return `${id} completed; to redo from a stage, --from-stage one of:\n${listRecorded(refusal.stages, now).join("\n")}`;
}

/** Stage records, a line each, in the order given: summary, attempt, and how long ago. */
function listRecorded(records: readonly StageRecord[], now: number): string[] {
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

/** Claims the run's next attempt, naming each earlier one found interrupted. */
export async function claimNext(
  run: Run,
  loaded: LoadedWorkflow,
  command: RunCommand,
  stderr: (text: string) => void,
  now: number,
): Promise<Attempt> {
  const { meta } = loaded.executable.definition;
  const claimed = await claimAttempt(
    run,
    {
      file: loaded.file,
      ...(meta.version === undefined ? {} : { workflowVersion: meta.version }),
      flags: {
        timeout: command.timeout,
        ...(command.fromStage === undefined ? {} : { fromStage: command.fromStage }),
      },
    },
    { fromStage: command.fromStage !== undefined },
  );
  if ("refused" in claimed) {
    throw new RunRefused(refusalMessage(run.record.id, claimed.refused, now));
  }
  const turns = claimed.interrupted.length > 0 ? await readTurns(run.dir).catch(() => []) : [];
  for (const earlier of claimed.interrupted) {
    // Its last turn says the stage it was in, as nothing else it wrote does.
    const stage = turns.findLast((turn) => turn.attempt === earlier.attempt)?.stage;
    stderr(
      `awf: attempt ${earlier.attempt} of ${run.record.id} was interrupted${stage ? ` in ${stage}` : ""}; its panes may still be open in Herdr workspace "${workspaceLabel(meta.name, run.record.id, earlier.attempt)}"`,
    );
  }
  return claimed.attempt;
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
    pathFrom(command.shellCwd, command.workflowFile),
    "--continue",
    id,
    ...(stop?.redo && stop.stage !== undefined ? ["--from-stage", stop.stage] : []),
  ]
    .map(shellWord)
    .join(" ");
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
