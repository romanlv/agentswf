import { statSync } from "node:fs";
import { homedir } from "node:os";
import { type AttemptRecord, RUN_EVENT_VERSIONS } from "@agentswf/contract/records";
import type { ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import { refusalMessage } from "./attempt-view";
import { messageOf } from "./errors";
import { projectOf, projectRunRoot } from "./projects";
import type { RunCommand } from "./run-command";
import {
  type Attempt,
  appendEvent,
  attemptRefusal,
  checkContinue,
  checkFree,
  claimAttempt,
  endTurnsLine,
  idProblem,
  openRun,
  previousGone,
  type Run,
  RunRefused,
  readAttempts,
  readStageRecords,
  readTurns,
} from "./runs";
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
  given: RunCommand,
  now: number,
  home: string = homedir(),
): Promise<
  | { loaded: LoadedWorkflow; prepared: PreparedRun; command: RunCommand }
  | { refused: string }
  | { opens: { loaded: LoadedWorkflow; id: string } }
> {
  let loaded: LoadedWorkflow;
  try {
    loaded = await loadWorkflowFile(given.workflowFile, given.shellCwd);
  } catch (error) {
    return { refused: `load: ${messageOf(error)}` };
  }
  let command = given;
  if (loaded.keyed) {
    const refused = keyedRefusal(command, loaded.file);
    if (refused) return { refused };
    if (command.id !== undefined) return { opens: { loaded, id: command.id } };
    // An event run lives in its file's project, whoever continues it (Q15).
    if (!command.runRootGiven) {
      try {
        command = { ...command, runRoot: projectRunRoot(await projectOf(loaded.file, home)) };
      } catch (error) {
        return { refused: messageOf(error) };
      }
    }
  }
  try {
    return { loaded, prepared: await prepareRun(command, loaded, now), command };
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
  // Once per start point: a run started at a stage goes on to it attempt after attempt.
  const unrecorded =
    fromStage !== undefined &&
    !records.has(fromStage) &&
    attempts.at(-1)?.flags.fromStage !== fromStage
      ? [`awf: nothing is recorded for ${fromStage}; the attempt stops if it never reaches it`]
      : [];
  return { args, continued: { run, attempts, warnings: unrecorded } };
}

/**
 * Why `awf run` doesn't take a workflow with `events` as asked: a new run needs `--id`, and
 * `--continue` goes on with it from wherever its attempt stopped.
 */
function keyedRefusal(command: RunCommand, file: string): string | undefined {
  if (command.workflowArgs.length > 0) return "a workflow with events takes no arguments";
  if (command.continueId === undefined) {
    if (command.id === undefined)
      return `a run of ${file} is named by its id: awf run --id {id} starts one with no event, awf emit --target ${file} --id {id} {event} {json} with one`;
    if (command.fromStage !== undefined || command.values !== undefined)
      return "a run of a workflow with events takes no --from-stage or --values";
    // Every attempt after the first is started by a wake, which passes none of these on.
    const unkept = [
      command.timeout === undefined ? undefined : "--timeout",
      command.sandbox === undefined ? undefined : "--sandbox",
      command.cwdGiven ? "--cwd" : undefined,
      command.runRootGiven ? "--run-root" : undefined,
    ].filter((flag) => flag !== undefined);
    if (unkept.length > 0)
      return `a run of a workflow with events runs in its file's project, as every wake starts it: it takes no ${unkept.join(", ")}`;
    return undefined;
  }
  if (command.fromStage !== undefined || command.values !== undefined)
    return "a run of a workflow with events takes no --from-stage or --values";
  if (command.workflowArgs.length > 0) return "a workflow with events takes no arguments";
  return undefined;
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

/** Claims the run's next attempt, naming each earlier one found interrupted. */
export async function claimNext(
  run: Run,
  loaded: LoadedWorkflow,
  command: RunCommand,
  notice: (text: string) => void,
  now: number,
): Promise<Attempt> {
  const { meta } = loaded.executable.definition;
  const claimed = await claimAttempt(
    run,
    {
      file: loaded.file,
      ...(meta.version === undefined ? {} : { workflowVersion: meta.version }),
      flags: {
        ...(command.timeout === undefined ? {} : { timeout: command.timeout }),
        ...(command.fromStage === undefined ? {} : { fromStage: command.fromStage }),
      },
    },
    { fromStage: command.fromStage !== undefined },
  );
  if ("refused" in claimed) {
    throw new RunRefused(refusalMessage(run.record.id, claimed.refused, now));
  }
  // An event run's: claimed first, which `wake` waits for holding the run's lock, then waited on
  // before this attempt writes anything, so the attempt before it has finished its own records and
  // two never share an agent's session.
  if (run.record.events) await previousGone(run, claimed.attempt.record.attempt, notice);
  // A crash may have torn the last line an earlier attempt appended; this attempt's first line
  // must not be glued to it.
  await endTurnsLine(run.dir)
    .then(() =>
      appendEvent(run.dir, {
        version: RUN_EVENT_VERSIONS["attempt-started"],
        attempt: claimed.attempt.record.attempt,
        at: claimed.attempt.record.started,
        kind: "attempt-started",
      }),
    )
    .catch((error) => notice(`awf: the run's event log was not written: ${messageOf(error)}`));
  const turns = claimed.interrupted.length > 0 ? await readTurns(run.dir).catch(() => []) : [];
  for (const earlier of claimed.interrupted) {
    // Its last turn says the stage it was in, as nothing else it wrote does.
    const stage = turns.findLast((turn) => turn.attempt === earlier.attempt)?.stage;
    notice(
      `awf: attempt ${earlier.attempt} of ${run.record.id} was interrupted${stage ? ` in ${stage}` : ""}; its panes may still be open in Herdr workspace "${workspaceLabel(meta.name, run.record.id, earlier.attempt)}"`,
    );
  }
  return claimed.attempt;
}

/** A run's Herdr workspace, which names the attempt: a dead one's may still be open. */
export function workspaceLabel(workflow: string, id: string, attempt: number): string {
  return `awf ${workflow} ${id} #${attempt}`;
}
