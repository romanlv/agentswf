import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { type EmitResultJson, MAILBOX_RECORD_VERSION } from "@agentswf/contract/records";
import { parseJsonSchema, validate } from "@agentswf/contract/schema";
import {
  AWF_ID_PREFIX,
  eventWorkflowProblem,
  type JsonValue,
  nameProblem,
} from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { exists } from "./files";
import { appendMailbox, foldMailbox, readMailbox } from "./mailbox";
import { projectOf, projectRunRoot, recordProject } from "./projects";
import { runLockFile, withRunLock } from "./run-lock";
import { prepareArgs } from "./run-prepare";
import { createRun, idProblem, openRun, type Run, readAttempts } from "./runs";
import { type WakeContext, type Woken, wake } from "./wake";
import type { EventWorkflow } from "./workflow-loader";

/** An event awf refuses to take at all: a name, shape or id no run of the target could have. */
export class EmitError extends Error {
  constructor(message: string) {
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
  event: { run: string; name: string; data: JsonValue; id?: string },
  context: EmitContext,
): Promise<EmitResultJson> {
  const workflow = target.meta.name;
  const { name, data } = event;
  checkEvent(target, event);
  const id = event.id ?? `${AWF_ID_PREFIX}${randomBytes(8).toString("hex")}`;
  const at = new Date(context.now?.() ?? Date.now()).toISOString();
  const runId = event.run;
  const problem = idProblem(runId);
  if (problem) throw new EmitError(`the run's id: ${problem}`);
  const project = await projectOf(target.file, context.home).catch((error: unknown) => {
    throw new EmitError(messageOf(error));
  });
  const starts = target.starts?.includes(name) ?? true;
  return deliver(
    {
      runRoot: projectRunRoot(project),
      workflow,
      runId,
      event: { id, name, data, from: context.from, at },
      deduplicate: event.id !== undefined,
      file: target.file,
      ...(starts ? { start: { project, target } } : {}),
    },
    context,
  );
}

/** An event for a run of a workflow with events, as `deliver` takes it. */
export type Delivery = {
  runRoot: string;
  workflow: string;
  runId: string;
  event: { id: string; name: string; data: JsonValue; from: string; at: string };
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
  });
  await recordProject(context.home, project);
  return run;
}

/** What `awf run --id` did to a run of a workflow with events: started it, or found it there. */
export type Opened = { run: string; created: boolean } & Woken;

/**
 * `awf run --id` for a workflow with events: creates the run with no event, under its lock, and
 * starts it, so it runs to its first wait and parks there. One already there is only woken, as
 * `awf tick` would; one that returned is refused, as its events are.
 */
export async function openEventRun(
  target: EventWorkflow,
  id: string,
  argv: readonly string[],
  context: Omit<WakeContext, "file">,
): Promise<Opened> {
  const workflow = target.meta.name;
  const problem = idProblem(id);
  if (problem) throw new EmitError(problem);
  const project = await projectOf(target.file, context.home).catch((error: unknown) => {
    throw new EmitError(messageOf(error));
  });
  const runRoot = projectRunRoot(project);
  const ref = `${workflow}/${id}`;
  return withRunLock(runLockFile(runRoot, workflow, id), async () => {
    const woken = { ...context, file: target.file };
    if (await exists(join(runRoot, workflow, id, "run.json"))) {
      const run = await openRun(runRoot, workflow, id);
      if ((await readAttempts(run)).at(-1)?.outcome === "completed")
        return { run: ref, created: false, did: "none", why: "returned" };
      if (argv.length > 0 && JSON.stringify(argv) !== JSON.stringify(run.record.argv))
        throw new EmitError(
          `${ref} is there already, started with ${run.record.argv.length > 0 ? "arguments of its own" : "none"}; awf run --id ${id} with none wakes it`,
        );
      return { run: ref, created: false, ...(await wake(run, woken)) };
    }
    try {
      prepareArgs(target, argv, project);
    } catch (error) {
      throw new EmitError(`prepare: ${messageOf(error)}`);
    }
    const run = await createEventRun(runRoot, workflow, id, project, target.file, context, argv);
    return { run: ref, created: true, ...(await wake(run, woken)) };
  });
}

/** The event's name, shape and id, as the target declares them; an `EmitError` when they don't fit. */
export function checkEvent(
  target: EventWorkflow,
  event: { name: string; data: JsonValue; id?: string },
): void {
  const workflow = target.meta.name;
  const problem = eventWorkflowProblem(target);
  if (problem) throw new EmitError(`${workflow}: ${problem}`);
  if (!isAbsolute(target.file))
    throw new EmitError(`${workflow}: its file, ${target.file}, is import.meta.path, absolute`);
  if (event.name.includes(":"))
    throw new EmitError(`${event.name}: a name with a colon is awf's own, and not sent`);
  const schema = target.events[event.name];
  if (!schema)
    throw new EmitError(
      `${workflow} declares no event ${event.name}; its events are ${Object.keys(target.events).join(", ")}`,
    );
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
  if (badId) throw new EmitError(`the id ${JSON.stringify(event.id)}: ${badId}`);
}

/** What is wrong with an id a sender gives an event, if anything: ids starting `awf.` are awf's. */
export function eventIdProblem(id: string): string | undefined {
  return (
    nameProblem(id) ??
    (id.startsWith(AWF_ID_PREFIX) ? `ids starting ${AWF_ID_PREFIX} are awf's own` : undefined)
  );
}
