import { statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AttemptRecord, RUN_EVENT_VERSIONS, type RunPanes } from "@agentswf/contract/records";
import { isEventWorkflow, type JsonValue } from "@agentswf/contract/workflow";
import { refusalMessage } from "./attempt-view";
import { messageOf } from "./errors";
import { exists } from "./files";
import { projectOf, projectRunRoot } from "./projects";
import type { RunCommand } from "./run-command";
import { claimRunLines, type RunLines, readRunLines } from "./run-lines";
import { crashedRedo } from "./run-policy/stages";
import {
  type Attempt,
  appendEvent,
  attemptRefusal,
  checkContinue,
  checkFree,
  claimAttempt,
  endTurnsLine,
  generateId,
  idProblem,
  openRun,
  previousGone,
  type Run,
  RunRefused,
  readAttempts,
  readTurns,
} from "./runs";
import {
  type AnyWorkflow,
  assertJsonValue,
  type LoadedWorkflow,
  loadWorkflowFile,
} from "./workflow-loader";

export type PreparedRun = {
  args: JsonValue;
  /** A new run's id, from `--id` or the workflow's `id(args)`; absent for one to generate. */
  id?: string;
  /** The run `--continue` names, its earlier attempts, and what to warn of before it goes on. */
  continued?: { run: Run; attempts: AttemptRecord[]; warnings: string[] };
  /**
   * The `--from-stage` a continue goes on with though none was given: that of the attempt before
   * it, which crashed inside its start stage.
   */
  resumes?: string;
};

/** `awf run --id` of a workflow with events, which starts the run detached, or wakes it. */
export type OpensEventRun = {
  loaded: LoadedWorkflow;
  id: string;
  argv: readonly string[];
  panes?: RunPanes;
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
  | { opens: OpensEventRun }
> {
  let loaded: LoadedWorkflow;
  try {
    loaded = await loadWorkflowFile(given.workflowFile, given.shellCwd);
  } catch (error) {
    return { refused: `load: ${messageOf(error)}` };
  }
  let command = given;
  if (isEventWorkflow(loaded.workflow)) {
    const refused = eventRunRefusal(command);
    if (refused) return { refused };
    // An event run lives and works in its file's project, whoever starts or continues it (Q15).
    let project: string;
    try {
      project = await projectOf(loaded.file, home);
    } catch (error) {
      return { refused: messageOf(error) };
    }
    if (!command.runRootGiven) command = { ...command, runRoot: projectRunRoot(project) };
    if (command.continueId === undefined) {
      // A run --id names is prepared only if it is made: one already there is woken with its own args.
      try {
        const id =
          command.id ??
          derivedId(loaded.workflow, prepareArgs(loaded.workflow, command.workflowArgs, project)) ??
          // Without starts no sender names its runs, so one may be generated, as a plain run's is.
          (loaded.workflow.starts === undefined
            ? await unusedId(command.runRoot, loaded.workflow.meta.name, now)
            : undefined);
        if (id === undefined)
          return {
            refused: `a run of ${loaded.file}, which starts on events, is named by its id, which --id or the workflow's id(args) gives: awf run --id {id} starts one, awf emit --target ${loaded.file} --id {id} {event} {json} starts one with an event`,
          };
        return {
          opens: {
            loaded,
            id,
            argv: command.workflowArgs,
            ...(command.panes ? { panes: command.panes } : {}),
          },
        };
      } catch (error) {
        return { refused: `${error instanceof RunRefused ? "" : "prepare: "}${messageOf(error)}` };
      }
    }
  }
  try {
    const prepared = await prepareRun(command, loaded, now);
    const { resumes } = prepared;
    return {
      loaded,
      prepared,
      command: resumes === undefined ? command : { ...command, fromStage: resumes },
    };
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
  const { workflow, file } = loaded;
  const { meta } = workflow;
  const prepare = (argv: readonly string[], cwd: string) => prepareArgs(workflow, argv, cwd);
  if (command.continueId === undefined) {
    const args = prepare(command.workflowArgs, command.cwd);
    const id = command.id ?? derivedId(workflow, args);
    if (id !== undefined) await checkFree(command.runRoot, meta.name, id);
    return { args, ...(id === undefined ? {} : { id }) };
  }
  const run = await openRun(command.runRoot, meta.name, command.continueId);
  checkContinue(run, {
    argv: command.workflowArgs,
    ...(command.cwdGiven ? { cwd: command.cwd } : {}),
    ...(command.sandbox === undefined ? {} : { sandbox: command.sandbox }),
    ...(command.panes === undefined ? {} : { panes: command.panes }),
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
  const { view } = await readRunLines(run.dir);
  // The claim refuses it too; this says so before `--here` opens a tab, or `--session` waits.
  const refused = attemptRefusal(attempts, view, { fromStage: command.fromStage !== undefined });
  if (refused) throw new RunRefused(refusalMessage(id, refused, now));
  // A plain run's redo that crashed inside its stage wrote no line, so nothing says it: it goes on
  // from there, as 018 has a crash mid-stage do. A wake carries no flag, so an event run's is lost.
  const resumes =
    command.fromStage === undefined && !isEventWorkflow(workflow)
      ? crashedRedo(attempts, view)
      : undefined;
  const fromStage = command.fromStage ?? resumes;
  // Once per start point: a run started at a stage goes on to it attempt after attempt.
  const unrecorded =
    fromStage !== undefined &&
    view.stages[fromStage] === undefined &&
    attempts.at(-1)?.flags.fromStage !== fromStage
      ? [`awf: nothing is recorded for ${fromStage}; the attempt stops if it never reaches it`]
      : [];
  const warnings =
    resumes === undefined
      ? unrecorded
      : [
          `awf: attempt ${attempts.at(-1)?.attempt} of ${id} ended without an ending inside --from-stage ${resumes}; this attempt starts there again`,
          ...unrecorded,
        ];
  return {
    args,
    continued: { run, attempts, warnings },
    ...(resumes === undefined ? {} : { resumes }),
  };
}

/** The workflow's args from `argv`, as its `prepare` makes them, checked to be JSON. */
export function prepareArgs(
  workflow: AnyWorkflow,
  argv: readonly string[],
  cwd: string,
): JsonValue {
  const args = workflow.prepare({ argv, cwd });
  assertJsonValue(args, `${workflow.meta.name} arguments`);
  return args;
}

/**
 * A generated id no run of `workflow` holds: `awf run` of one already there would wake it. Taken
 * between this and the open, by a run started the same minute with the same four digits, it is.
 */
async function unusedId(runRoot: string, workflow: string, now: number): Promise<string> {
  for (let tries = 1; ; tries += 1) {
    const id = generateId(new Date(now));
    if (!(await exists(join(runRoot, workflow, id)))) return id;
    if (tries >= 5) throw new RunRefused("every id generated was taken; --id gives one");
  }
}

/**
 * Why `awf run` doesn't take a workflow with `events` as asked: every attempt after the first is
 * started by a wake, which passes on none of the flags a run would have to keep. A `--from-stage`
 * is the one attempt's, and its stage line keeps what it redid.
 */
function eventRunRefusal(command: RunCommand): string | undefined {
  if (command.values !== undefined)
    return "a run of a workflow with events takes no --values: before --from-stage, a stage with no record runs";
  if (command.fromStage !== undefined && command.continueId === undefined)
    return "a run of a workflow with events takes --from-stage only with --continue";
  if (command.continueId !== undefined) {
    if (command.workflowArgs.length > 0)
      return "a continue takes no arguments: it goes on with those its run was started with";
    return undefined;
  }
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

/** The id the workflow's `id(args)` gives a new run, checked; undefined when it has none. */
function derivedId(workflow: AnyWorkflow, args: JsonValue): string | undefined {
  if (!workflow.id) return undefined;
  let id: unknown;
  try {
    id = workflow.id(args);
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
  const { meta } = loaded.workflow;
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
  // Claimed first, which `wake` waits for holding the run's lock, then waited on before this
  // attempt writes anything, so the attempt before it has finished its own records and two never
  // share an agent's session.
  const n = claimed.attempt.record.attempt;
  await previousGone(run, n, notice);
  let lines: RunLines;
  try {
    lines = await claimRunLines(run.dir, n, claimed.attempt.record.started);
  } catch (error) {
    // Without its fence the attempt may not write: it goes, as a refused claim's does.
    await unlink(claimed.attempt.file).catch(() => undefined);
    throw new Error(`run.jsonl was not claimed: ${messageOf(error)}`);
  }
  // A crash may have torn the last line an earlier attempt appended; this attempt's first line
  // must not be glued to it.
  await endTurnsLine(run.dir)
    .then(() =>
      appendEvent(run.dir, {
        version: RUN_EVENT_VERSIONS["attempt-started"],
        attempt: n,
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
  return { ...claimed.attempt, lines };
}

/** A run's Herdr workspace, which names the attempt: a dead one's may still be open. */
export function workspaceLabel(workflow: string, id: string, attempt: number): string {
  return `awf ${workflow} ${id} #${attempt}`;
}
