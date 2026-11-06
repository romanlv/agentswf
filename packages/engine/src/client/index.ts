import { homedir } from "node:os";
import { type Client, ClientError, type ClientOptions } from "@agentswf/contract/client";
import type { EmitResultJson, InboxItemJson } from "@agentswf/contract/records";
import { awfEventOf, type JsonValue } from "@agentswf/contract/workflow";
import { checkEvent, deliverReply, emitEvent } from "../emit";
import { inboxCommand } from "../inbox-command";
import { asClientError, clientCode } from "../refusals";
import type { WakeContext } from "../wake";
import type { AnyWorkflow, EventWorkflow } from "../workflow-loader";
import { assertEventWorkflow, checkCursor, checkEmit, checkRunId } from "./checks";
import { locate } from "./locate";
import { get, openExact, start } from "./runs";

/** What the client runs each call with: the operator's home and environment, and how it launches. */
export type ClientContext = Omit<WakeContext, "file"> & {
  /** How often a wait reads the run's files. */
  pollMs?: number;
};

/**
 * A program's way to its workflows' runs, in its own process: the code `awf emit`, `awf inbox` and
 * the run readers run, on the engine the workflow's project depends on (ADR 0015).
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

async function emit(
  workflow: EventWorkflow,
  runId: string,
  name: string,
  data: JsonValue,
  given: { eventId?: string; source?: string },
  context: ClientContext,
): Promise<EmitResultJson> {
  assertEventWorkflow(workflow);
  const located = await locate(workflow, context.home);
  const ref = `${workflow.meta.name}/${runId}`;
  checkEmit(ref, runId, name, data, given);
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
    checkRunId(runId, ref);
    const run = await openExact(located.runRoot, workflow.meta.name, runId, "id");
    if (!run)
      throw new ClientError(
        "no-run",
        `no run ${ref} in ${located.project}: a reply never starts one`,
        ref,
      );
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
  checkCursor(after);
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
    items.length > 0 ? (JSON.parse(items.at(-1)!) as { code?: string; error?: string }) : {};
  const known = clientCode(refused.code);
  if (known) throw new ClientError(known, refused.error ?? known);
  throw new Error(refused.error ?? (errors.join("\n") || `awf inbox exited ${code}`));
}
