import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { type EmitResultJson, MAILBOX_RECORD_VERSION } from "@agentswf/contract/records";
import { parseJsonSchema, validate } from "@agentswf/contract/schema";
import {
  AWF_ID_PREFIX,
  type EventSchemas,
  type EventWorkflowDefinition,
  eventWorkflowProblem,
  type JsonValue,
  nameProblem,
  type OwnEvent,
} from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { exists } from "./files";
import { keyLockFile, withKeyLock } from "./key-lock";
import { appendMailbox, foldMailbox, readMailbox } from "./mailbox";
import { projectOf, projectRunRoot, recordProject } from "./projects";
import { createRun, idProblem, openRun, type Run, readAttempts } from "./runs";
import { type WakeContext, type Woken, wake } from "./wake";

/** A workflow with `events`, as a sender has it: its definition, and the file it lives in. */
export type EmitTarget = {
  file: string;
  definition: EventWorkflowDefinition<EventSchemas, JsonValue>;
};

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
 * A sender's way in: checks the event against its target, keys it, and delivers it. A wrong name,
 * shape or id throws an `EmitError`; the run's state is the outcome.
 */
export async function emitEvent(
  target: EmitTarget,
  event: { name: string; data: JsonValue; id?: string },
  context: EmitContext,
): Promise<EmitResultJson> {
  const { definition } = target;
  const workflow = definition.meta.name;
  const { name, data } = event;
  checkEvent(target, event);
  const id = event.id ?? `${AWF_ID_PREFIX}${randomBytes(8).toString("hex")}`;
  const at = new Date(context.now?.() ?? Date.now()).toISOString();
  const key = keyOf(definition, { id, name, data, from: context.from, at });
  const runId = `${workflow}.${key}`;
  const problem = idProblem(runId);
  if (problem) throw new EmitError(`the run's id, ${runId}: ${problem}`);
  const project = await projectOf(target.file, context.home).catch((error: unknown) => {
    throw new EmitError(messageOf(error));
  });
  return deliver(
    {
      runRoot: projectRunRoot(project),
      workflow,
      runId,
      event: { id, name, data, from: context.from, at },
      deduplicate: event.id !== undefined,
      file: target.file,
      ...(definition.starts.includes(name) ? { start: { key, project } } : {}),
    },
    context,
  );
}

/** An event for a keyed run, as `deliver` takes it. */
export type Delivery = {
  runRoot: string;
  workflow: string;
  runId: string;
  event: { id: string; name: string; data: JsonValue; from: string; at: string };
  /** False for an id awf made at random, which nothing repeats. */
  deduplicate: boolean;
  /** Given when the event may start the run: what a new run records. */
  start?: { key: string; project: string };
  /** The file a sender named, which a start or continue runs; absent, the run's last. */
  file?: string;
};

/**
 * The one way in, for every event a keyed run gets: a sender's, a participant's reply, or awf's
 * own. Under the key's lock it finds a duplicate, refuses the event, or creates the run, appends
 * the event and wakes the run.
 */
export async function deliver(
  delivery: Delivery,
  context: Omit<WakeContext, "file">,
): Promise<EmitResultJson> {
  const { runRoot, workflow, runId, event, start, file } = delivery;
  const woken = { ...context, ...(file ? { file } : {}) };
  const ref = `${workflow}/${runId}`;
  return withKeyLock(keyLockFile(runRoot, workflow, runId), async () => {
    let run: Run | undefined = (await exists(join(runRoot, workflow, runId, "run.json")))
      ? await openRun(runRoot, workflow, runId)
      : undefined;
    // What was due is `awf tick`'s to say; an emit's caller knows it sent an event.
    const result = (outcome: EmitResultJson["outcome"], { cause: _, ...woken }: Woken) =>
      ({ v: 1, outcome, run: ref, id: event.id, ...woken }) satisfies EmitResultJson;
    if (run) {
      // Not appended again, but it still wakes the run: a sender retrying after a launch that failed
      // sends the same id.
      if (delivery.deduplicate && foldMailbox(await readMailbox(run.dir)).events.has(event.id))
        return result("duplicate", await wake(run, { ...woken, nudgeLive: false }));
      if ((await readAttempts(run)).at(-1)?.outcome === "completed")
        return result("refused", { did: "none", why: "returned" });
    } else {
      if (!start) return result("refused", { did: "none", why: "not-a-start" });
      run = await createRun(runRoot, {
        id: runId,
        workflow,
        argv: [],
        cwd: start.project,
        sandbox: null,
        key: start.key,
        env: { PATH: context.environment.PATH ?? "" },
        ...(file ? { file } : {}),
      });
      await recordProject(context.home, start.project);
    }
    await appendMailbox(run.dir, {
      version: MAILBOX_RECORD_VERSION,
      kind: "event",
      ...event,
    });
    return result("accepted", await wake(run, woken));
  });
}

/** The event's name, shape and id, as the target declares them; an `EmitError` when they don't fit. */
export function checkEvent(
  target: EmitTarget,
  event: { name: string; data: JsonValue; id?: string },
): void {
  const { definition } = target;
  const workflow = definition.meta.name;
  const problem = eventWorkflowProblem(definition);
  if (problem) throw new EmitError(`${workflow}: ${problem}`);
  if (!isAbsolute(definition.file))
    throw new EmitError(`${workflow}: its file, ${definition.file}, is import.meta.path, absolute`);
  if (event.name.includes(":"))
    throw new EmitError(`${event.name}: a name with a colon is awf's own, and not sent`);
  const schema = definition.events[event.name];
  if (!schema)
    throw new EmitError(
      `${workflow} declares no event ${event.name}; its events are ${Object.keys(definition.events).join(", ")}`,
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

export function keyOf(
  definition: EventWorkflowDefinition<EventSchemas, JsonValue>,
  event: OwnEvent<EventSchemas>,
): string {
  let key: unknown;
  try {
    key = definition.key(event);
  } catch (error) {
    throw new EmitError(`${definition.meta.name}'s key(event) threw: ${String(error)}`);
  }
  if (typeof key !== "string") throw new EmitError(`key(event) gave a ${typeof key}, not a string`);
  const problem = nameProblem(key);
  if (problem) throw new EmitError(`the key ${JSON.stringify(key)}: ${problem}`);
  return key;
}
