import { homedir } from "node:os";
import { join } from "node:path";
import { type Client, ClientError, type ClientOptions } from "@agentswf/contract/client";
import type { EmitResultJson, InboxItemJson } from "@agentswf/contract/records";
import { awfEventOf, isEventWorkflow, type JsonValue } from "@agentswf/contract/workflow";
import { checkEvent, deliverReply, EmitError, emitEvent } from "../emit";
import { exists } from "../files";
import { inboxCommand } from "../inbox-command";
import { idProblem, openRun } from "../runs";
import type { WakeContext } from "../wake";
import type { AnyWorkflow, EventWorkflow } from "../workflow-loader";
import { locate } from "./locate";
import { get, start } from "./runs";

/** What the client runs each call with: the operator's home and environment, and how it launches. */
export type ClientContext = Omit<WakeContext, "file"> & {
  /** How often a wait reads the run's files. */
  pollMs?: number;
};

/**
 * A program's way to its workflows' runs, in its own process: the code `awf emit`, `awf inbox` and
 * the run readers run, on the engine the workflow's project depends on (ADR 0014).
 */
export function client(options: ClientOptions = {}): Client {
  return clientWith(options);
}

/**
 * `client`, with what a test fakes: how an attempt is launched, a live run nudged, and the time.
 * Not published: a program that launched nothing would record events no run ever takes.
 */
export function clientWith(
  options: ClientOptions & Pick<WakeContext, "launch" | "nudge" | "now"> & { pollMs?: number },
): Client {
  const context: ClientContext = {
    home: options.home ?? homedir(),
    environment: options.environment ?? process.env,
    ...(options.launch ? { launch: options.launch } : {}),
    ...(options.nudge ? { nudge: options.nudge } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  };
  return {
    emit: (workflow, run, name, data, given) =>
      emit(workflow as EventWorkflow, run, name, data as JsonValue, given ?? {}, context),
    inbox: (workflow, given) => inbox(workflow as AnyWorkflow, given?.after, context),
    start: (workflow, args, given) =>
      start(workflow as AnyWorkflow, args, given ?? {}, context) as never,
    get: (workflow, id) => get(workflow as AnyWorkflow, id, context) as never,
  };
}

/** An `EmitError` as the caller's mistake it is; anything else as it is. */
export function asClientError(error: unknown, ref?: string): unknown {
  if (error instanceof EmitError) return new ClientError(error.code, error.message, ref);
  return error;
}

async function emit(
  workflow: EventWorkflow,
  runId: string,
  name: string,
  data: JsonValue,
  given: { eventId?: string; source?: string },
  context: ClientContext,
): Promise<EmitResultJson> {
  if (!isEventWorkflow(workflow))
    throw new ClientError(
      "event",
      `${(workflow as AnyWorkflow)?.meta?.name} declares no events; start runs it`,
    );
  const located = await locate(workflow, context.home);
  const ref = `${workflow.meta.name}/${runId}`;
  // What the types rule out, refused as the caller's mistake when it comes anyway.
  if (typeof name !== "string") throw new ClientError("event", "an event's name is a string", ref);
  if (typeof runId !== "string") throw new ClientError("id", "a run's id is a string");
  for (const [field, value] of [
    ["eventId", given.eventId],
    ["source", given.source],
  ] as const)
    if (value !== undefined && typeof value !== "string")
      throw new ClientError(field === "eventId" ? "id" : "event", `${field} is a string`, ref);
  const event = {
    name,
    data,
    ...(given.eventId === undefined ? {} : { id: given.eventId }),
    ...(given.source === undefined ? {} : { source: given.source }),
  };
  try {
    const reply = awfEventOf(name);
    if (reply?.kind !== "reply")
      return await emitEvent(workflow, { run: runId, ...event }, { from: "operator", ...context });
    // Checked against the value given, not the run's file: the program holds the workflow, and no
    // author surface is served to it.
    checkEvent(workflow, event, true);
    const problem = idProblem(runId);
    if (problem) throw new ClientError("id", `the run's id: ${problem}`, ref);
    if (!(await exists(join(located.runRoot, workflow.meta.name, runId, "run.json"))))
      throw new ClientError(
        "no-run",
        `no run ${ref} in ${located.project}: a reply never starts one`,
        ref,
      );
    const run = await openRun(located.runRoot, workflow.meta.name, runId);
    if (run.record.id !== runId)
      throw new ClientError("id", `${ref} differs only in case from ${run.record.id}`, ref);
    return await deliverReply({ run }, reply.key, event, context);
  } catch (error) {
    throw asClientError(error, ref);
  }
}

async function inbox(
  workflow: AnyWorkflow,
  after: string | undefined,
  context: ClientContext,
): Promise<InboxItemJson[]> {
  const located = await locate(workflow, context.home);
  // A cursor is an item's, never an option of the command it is read with.
  if (after !== undefined && (typeof after !== "string" || after === "" || after.startsWith("-")))
    throw new ClientError("cursor", `${JSON.stringify(after)} is no cursor an item carried`);
  const lines: string[] = [];
  const errors: string[] = [];
  // `awf inbox --workflow --json`'s own reader, so what a program reads is what the command lists.
  const code = await inboxCommand(
    [
      "--workflow",
      workflow.meta.name,
      "--run-root",
      located.runRoot,
      "--json",
      ...(after === undefined ? [] : ["--after", after]),
    ],
    located.project,
    { stdout: (text) => lines.push(text), stderr: (text) => errors.push(text) },
    { home: context.home },
  );
  const items = lines.flatMap((line) => line.split("\n")).filter((line) => line !== "");
  if (code === 0) return items.map((line) => JSON.parse(line) as InboxItemJson);
  const refused =
    items.length > 0 ? (JSON.parse(items[0]!) as { code?: string; error?: string }) : {};
  if (refused.code === "bad-cursor") throw new ClientError("cursor", refused.error ?? "cursor");
  throw new Error(refused.error ?? (errors.join("\n") || `awf inbox exited ${code}`));
}
