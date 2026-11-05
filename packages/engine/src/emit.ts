import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { ClientErrorCode } from "@agentswf/contract/client";
import {
  type EmitResultJson,
  MAILBOX_RECORD_VERSION,
  type RunPanes,
} from "@agentswf/contract/records";
import { parseJsonSchema, validate } from "@agentswf/contract/schema";
import {
  AWF_ID_PREFIX,
  awfEventOf,
  eventWorkflowProblem,
  isEventWorkflow,
  type JsonValue,
  nameProblem,
  ParticipantReply,
} from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { exists } from "./files";
import { appendMailbox, foldMailbox, readMailbox } from "./mailbox";
import { checkProjectEngine, EngineRefused } from "./project-engine";
import { projectOf, projectRunRoot, recordProject } from "./projects";
import { runLockFile, withRunLock } from "./run-lock";
import { prepareArgs } from "./run-prepare";
import type { RunStatus } from "./run-state";
import { createRun, idProblem, openRun, panesChanged, type Run, readAttempts } from "./runs";
import { type WakeContext, type Woken, wake } from "./wake";
import { type EventWorkflow, loadWorkflowFile } from "./workflow-loader";

/**
 * What an `EmitError` is about, as a program's `ClientError` names it: the event, an id, the
 * target's `prepare` or `id(args)`, its file, its project, or the project's engine.
 */
export type EmitCode = Extract<
  ClientErrorCode,
  "event" | "id" | "prepare" | "file" | "project" | "other-engine" | "no-engine"
>;

/** An event awf refuses to take at all: a name, shape or id no run of the target could have. */
export class EmitError extends Error {
  constructor(
    message: string,
    readonly code: EmitCode = "event",
  ) {
    super(message);
    this.name = "EmitError";
  }
}

export type EmitContext = Omit<WakeContext, "file"> & {
  /** As `WorkflowEvent.from`: the sending run's ref, or `operator`. */
  from: string;
};

/**
 * A sender's way in: checks the event against its target and delivers it to the run it names. A wrong name,
 * shape or id throws an `EmitError`; the run's state is the outcome.
 */
export async function emitEvent(
  target: EventWorkflow,
  event: { run: string; name: string; data: JsonValue; id?: string; source?: string },
  context: EmitContext,
): Promise<EmitResultJson> {
  const workflow = target.meta.name;
  const { name, data, source } = event;
  checkEvent(target, event);
  const badSource = source === undefined ? undefined : nameProblem(source);
  if (badSource) throw new EmitError(`the source ${JSON.stringify(source)}: ${badSource}`);
  const file = fileOf(target);
  const id = event.id ?? `${AWF_ID_PREFIX}${randomBytes(8).toString("hex")}`;
  const at = new Date(context.now?.() ?? Date.now()).toISOString();
  const runId = event.run;
  const problem = idProblem(runId);
  if (problem) throw new EmitError(`the run's id: ${problem}`, "id");
  const project = await targetProject(file, context.home);
  const starts = target.starts?.includes(name) ?? true;
  return deliver(
    {
      runRoot: projectRunRoot(project),
      workflow,
      runId,
      event: {
        id,
        name,
        data,
        from: context.from,
        ...(source === undefined ? {} : { source }),
        at,
      },
      deduplicate: event.id !== undefined,
      file,
      ...(starts ? { start: { project, target } } : {}),
    },
    context,
  );
}

/**
 * `awf emit {ref} {key}:reply …`: a participant's message to the code of a run that is there,
 * checked against the definition in the file a wake would run, its last attempt's, and delivered.
 * It never starts a run, and doesn't ask whether the participant has connected: one sent before
 * the run connects it waits in the mailbox for the run's next wait.
 */
export async function emitToRun(
  status: RunStatus,
  event: { name: string; data: JsonValue; id?: string; source?: string },
  context: Omit<WakeContext, "file">,
): Promise<EmitResultJson> {
  const { run, ref } = status;
  const reply = awfEventOf(event.name);
  if (reply?.kind !== "reply")
    throw new EmitError(
      `awf emit {run} sends a participant's message to the code, {key}:reply, not ${event.name}; the workflow's own events go by --target {file} --id {id}`,
    );
  if (!run.record.events) throw new EmitError(`${ref} is a run of a workflow without events`);
  // A returned run takes nothing, so its file, since moved or changed, is not read: a late reply is
  // refused as returned, not failed for a retry that never ends.
  if (status.attempts.at(-1)?.outcome === "completed")
    return deliverReply(status, reply.key, event, context);
  const file = status.attempts.at(-1)?.file ?? run.record.file;
  if (file === undefined) throw new Error(`${ref} has no file to check the event against`);
  const { workflow } = await loadWorkflowFile(file, run.record.cwd, context.home);
  if (!isEventWorkflow(workflow) || workflow.meta.name !== run.record.workflow)
    throw new Error(`${file} is no longer ${run.record.workflow} with events, which ${ref} ran`);
  checkEvent(workflow, event, true);
  return deliverReply(status, reply.key, event, context);
}

/**
 * `{key}:reply` appended to a run that is there, and the run woken: a duplicate id is a duplicate.
 * The caller has checked it.
 */
export function deliverReply(
  status: Pick<RunStatus, "run">,
  key: string,
  event: { data: JsonValue; id?: string; source?: string },
  context: Omit<WakeContext, "file">,
): Promise<EmitResultJson> {
  const { run } = status;
  const problem = event.source === undefined ? undefined : nameProblem(event.source);
  if (problem) throw new EmitError(`the source ${JSON.stringify(event.source)}: ${problem}`);
  const at = new Date(context.now?.() ?? Date.now()).toISOString();
  const id = event.id ?? `${AWF_ID_PREFIX}${randomBytes(8).toString("hex")}`;
  return deliver(
    {
      runRoot: run.root,
      workflow: run.record.workflow,
      runId: run.record.id,
      event: {
        ...replyRecord(key, id, event.data, at),
        ...(event.source === undefined ? {} : { source: event.source }),
      },
      deduplicate: event.id !== undefined,
    },
    context,
  );
}

/** An event for a run of a workflow with events, as `deliver` takes it. */
export type Delivery = {
  runRoot: string;
  workflow: string;
  runId: string;
  event: { id: string; name: string; data: JsonValue; from: string; source?: string; at: string };
  /** False for an id awf made at random, which nothing repeats. */
  deduplicate: boolean;
  /** Given when the event may start the run: what a new run records, and the workflow it prepares. */
  start?: { project: string; target: EventWorkflow };
  /** The file a sender named, which a start or continue runs; absent, the run's last. */
  file?: string;
};

/**
 * The one way in, for every event a run of a workflow with events gets: a sender's, a participant's reply, or awf's
 * own. Under the run's lock it finds a duplicate, refuses the event, or creates the run, appends
 * the event and wakes the run.
 */
export async function deliver(
  delivery: Delivery,
  context: Omit<WakeContext, "file">,
): Promise<EmitResultJson> {
  const { runRoot, workflow, runId, event, start, file } = delivery;
  const woken = { ...context, ...(file ? { file } : {}) };
  const ref = `${workflow}/${runId}`;
  return withRunLock(runLockFile(runRoot, workflow, runId), async () => {
    let run: Run | undefined = (await exists(join(runRoot, workflow, runId, "run.json")))
      ? await openRun(runRoot, workflow, runId)
      : undefined;
    // What was due is `awf tick`'s to say; an emit's caller knows it sent an event.
    const result = (outcome: EmitResultJson["outcome"], { cause: _, ...woken }: Woken) =>
      ({ v: 1, outcome, ref, eventId: event.id, ...woken }) satisfies EmitResultJson;
    if (run) {
      // A disk that doesn't tell case apart opens another run for an id differing only in case.
      if (run.record.id !== runId)
        throw new EmitError(
          `${ref} differs only in case from ${run.record.id}, which is there`,
          "id",
        );
      if (!run.record.events)
        throw new EmitError(`${ref} is a run of a workflow without events, which take none`);
      // Not appended again, but it still wakes the run: a sender retrying after a launch that failed
      // sends the same id.
      if (delivery.deduplicate && foldMailbox(await readMailbox(run.dir)).events.has(event.id))
        return result("duplicate", await wake(run, { ...woken, nudgeLive: false }));
      if ((await readAttempts(run)).at(-1)?.outcome === "completed")
        return result("refused", { did: "none", why: "returned" });
    }
    const starts = !run;
    if (!run) {
      if (!start) return result("refused", { did: "none", why: "not-a-start" });
      checkStartArgs(start.target, start.project);
      run = await createEventRun(runRoot, workflow, runId, start.project, file, context);
    }
    await appendMailbox(run.dir, {
      version: MAILBOX_RECORD_VERSION,
      kind: "event",
      ...event,
      ...(starts ? { starts: true as const } : {}),
    });
    return result("accepted", await wake(run, woken));
  });
}

/**
 * A run an event starts has no argv: its args are what `prepare` makes of none, checked before the
 * run is made, so a workflow that needs args refuses the sender and leaves no run.
 */
function checkStartArgs(target: EventWorkflow, project: string): void {
  try {
    prepareArgs(target, [], project);
  } catch (error) {
    throw new EmitError(
      `${target.meta.name}: a run an event starts has no arguments, which its prepare refuses: ${messageOf(error)}`,
      "prepare",
    );
  }
}

/** A new run of a workflow with events, in `project`, recorded so `awf tick` finds it. */
async function createEventRun(
  runRoot: string,
  workflow: string,
  id: string,
  project: string,
  file: string | undefined,
  context: Pick<WakeContext, "home" | "environment">,
  argv: readonly string[] = [],
  panes?: RunPanes,
): Promise<Run> {
  const run = await createRun(runRoot, {
    id,
    workflow,
    argv: [...argv],
    cwd: project,
    sandbox: null,
    events: true,
    env: { PATH: context.environment.PATH ?? "" },
    ...(file ? { file } : {}),
    ...(panes ? { panes } : {}),
  });
  await recordProject(context.home, project);
  return run;
}

/** What `awf run --id` did to a run of a workflow with events: started it, or found it there. */
export type Opened = { run: string; created: boolean } & Woken;

/**
 * `awf run --id` for a workflow with events: creates the run with no event, under its lock, and
 * starts it, so it runs to its first wait and parks there. One already there is only woken, as
 * `awf tick` would; one that returned is refused, as its events are. `panes`, the operator's
 * `--workspace` and `--keep-panes`, are recorded with a new run, and may not change one there.
 */
export async function openEventRun(
  target: EventWorkflow,
  id: string,
  argv: readonly string[],
  context: Omit<WakeContext, "file">,
  panes?: RunPanes,
): Promise<Opened> {
  const workflow = target.meta.name;
  const problem = idProblem(id);
  if (problem) throw new EmitError(problem, "id");
  const file = fileOf(target);
  const project = await targetProject(file, context.home);
  const runRoot = projectRunRoot(project);
  const ref = `${workflow}/${id}`;
  return withRunLock(runLockFile(runRoot, workflow, id), async () => {
    const woken = { ...context, file };
    if (await exists(join(runRoot, workflow, id, "run.json"))) {
      const run = await openRun(runRoot, workflow, id);
      if ((await readAttempts(run)).at(-1)?.outcome === "completed")
        return { run: ref, created: false, did: "none", why: "returned" };
      if (argv.length > 0 && JSON.stringify(argv) !== JSON.stringify(run.record.argv))
        throw new EmitError(
          `${ref} is there already, started with ${run.record.argv.length > 0 || run.record.args !== undefined ? "arguments of its own" : "none"}; awf run --id ${id} with none wakes it`,
        );
      const changed = panesChanged(run.record, panes);
      if (changed) throw new EmitError(changed);
      return { run: ref, created: false, ...(await wake(run, woken)) };
    }
    try {
      prepareArgs(target, argv, project);
    } catch (error) {
      throw new EmitError(`prepare: ${messageOf(error)}`, "prepare");
    }
    const run = await createEventRun(runRoot, workflow, id, project, file, context, argv, panes);
    return { run: ref, created: true, ...(await wake(run, woken)) };
  });
}

/** The project `file`'s runs live in, which must run on this engine (ADR 0014). */
async function targetProject(file: string, home: string): Promise<string> {
  const project = await projectOf(file, home).catch((error: unknown) => {
    throw new EmitError(messageOf(error), "project");
  });
  try {
    checkProjectEngine(project, { file });
  } catch (error) {
    if (error instanceof EngineRefused) throw new EmitError(error.message, error.code);
    throw error;
  }
  return project;
}

/**
 * The target's file, which says which project its runs live in and which a start or wake runs:
 * `file`, or the path awf loaded it from. Only a sender holding the workflow itself, as `wf.emit`
 * does, can be without one.
 */
function fileOf(target: EventWorkflow): string {
  if (target.file === undefined)
    throw new EmitError(
      `${target.meta.name} gives no file, by which a sender holding it finds it: file: import.meta.path`,
      "file",
    );
  return target.file;
}

/**
 * `{key}:reply`'s event as the mailbox records it: `participant:reply` from its key, whatever the
 * workflow declares it as, so a wait takes it by one name.
 */
export function replyRecord(
  key: string,
  id: string,
  data: JsonValue,
  at: string,
): Delivery["event"] {
  return { id, name: "participant:reply", data, from: key, at };
}

/**
 * The event's name, shape and id, as the target declares them; an `EmitError` when they don't fit.
 * A name with a colon is awf's: only `{key}:reply`, from the operator (`replies`), is sent.
 */
export function checkEvent(
  target: EventWorkflow,
  event: { name: string; data: JsonValue; id?: string },
  replies = false,
): void {
  const workflow = target.meta.name;
  const problem = eventWorkflowProblem(target);
  if (problem) throw new EmitError(`${workflow}: ${problem}`);
  if (target.file !== undefined && !isAbsolute(target.file))
    throw new EmitError(
      `${workflow}: its file, ${target.file}, is import.meta.path, absolute`,
      "file",
    );
  const reply = awfEventOf(event.name)?.kind === "reply";
  if (event.name.includes(":") && !(replies && reply))
    throw new EmitError(
      reply
        ? `${event.name}: a participant's message goes to a run that is there, awf emit ${workflow}/{id} ${event.name} '{"text":…}'`
        : `${event.name}: a name with a colon is awf's own, and not sent`,
    );
  const declared = target.events[event.name];
  if (!declared)
    throw new EmitError(
      `${workflow} declares no event ${event.name}; its events are ${Object.keys(target.events).join(", ")}`,
    );
  // A reply is checked against awf's own schema, not the workflow's copy, which may be older.
  const schema = reply ? ParticipantReply : declared;
  let parsed: ReturnType<typeof parseJsonSchema>;
  try {
    parsed = parseJsonSchema(schema);
  } catch (error) {
    throw new EmitError(`${workflow}'s schema for ${event.name}: ${String(error)}`);
  }
  const errors = validate(parsed, event.data);
  if (errors.length > 0)
    throw new EmitError(
      `${event.name}'s data does not fit its schema: ${errors.map((e) => `${e.path || "/"}: ${e.message}`).join("; ")}`,
    );
  const badId = event.id === undefined ? undefined : eventIdProblem(event.id);
  if (badId) throw new EmitError(`the id ${JSON.stringify(event.id)}: ${badId}`, "id");
}

/** What is wrong with an id a sender gives an event, if anything: ids starting `awf.` are awf's. */
export function eventIdProblem(id: string): string | undefined {
  return (
    nameProblem(id) ??
    (id.startsWith(AWF_ID_PREFIX) ? `ids starting ${AWF_ID_PREFIX} are awf's own` : undefined)
  );
}
