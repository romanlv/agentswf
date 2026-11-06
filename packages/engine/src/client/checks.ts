// The client's checks of what a program gives it that need no file: the fake client runs these
// too, so a program's tests see the very `ClientError` the real client throws.
import { isAbsolute } from "node:path";
import { ClientError } from "@agentswf/contract/client";
import { isEventWorkflow, isJsonValue, type JsonValue } from "@agentswf/contract/workflow";
import { messageOf } from "../errors";
import { idProblem } from "../runs";
import { type AnyWorkflow, assertJsonValue, type EventWorkflow } from "../workflow-loader";

/** `workflow`'s `file`, by which a program finds it and its runs. */
export function fileOf(workflow: AnyWorkflow): string {
  const file = (workflow as { file?: unknown })?.file;
  if (typeof file !== "string" || !isAbsolute(file))
    throw new ClientError(
      "file",
      `${workflow?.meta?.name ?? "the workflow"} gives no file, by which a program finds it and its runs: file: import.meta.path`,
    );
  return file;
}

/** `workflow`'s `meta.name`, checked as an id is. */
export function nameOf(workflow: AnyWorkflow): string {
  const name = workflow?.meta?.name;
  const problem = idProblem(name);
  if (problem) throw new ClientError("event", `meta.name: ${problem}`);
  return name;
}

export function assertEventWorkflow(workflow: AnyWorkflow): asserts workflow is EventWorkflow {
  if (!isEventWorkflow(workflow))
    throw new ClientError("event", `${workflow?.meta?.name} declares no events; start runs it`);
}

/** What the types rule out in an emit, refused as the caller's mistake when it comes anyway. */
export function checkEmit(
  ref: string,
  runId: string,
  name: string,
  data: unknown,
  given: { eventId?: string; source?: string },
): asserts data is JsonValue {
  if (typeof name !== "string") throw new ClientError("event", "an event's name is a string", ref);
  if (typeof runId !== "string") throw new ClientError("id", "a run's id is a string");
  for (const [field, value] of [
    ["eventId", given.eventId],
    ["source", given.source],
  ] as const)
    if (value !== undefined && typeof value !== "string")
      throw new ClientError(field === "eventId" ? "id" : "event", `${field} is a string`, ref);
  // What tsc lets through in a value that isn't a literal: in.jsonl keeps JSON only.
  if (!isJsonValue(data))
    throw new ClientError("event", `${name}'s data must contain only JSON values`, ref);
}

export function checkArgs(name: string, args: unknown): asserts args is JsonValue {
  try {
    assertJsonValue(args, `${name} arguments`);
  } catch (error) {
    throw new ClientError("prepare", messageOf(error));
  }
}

/** The id `id(args)` gives, checked; a workflow with `starts` and none is refused. */
export function derivedId(workflow: AnyWorkflow, args: JsonValue): string | undefined {
  const name = workflow.meta.name;
  if (!workflow.id) {
    if (isEventWorkflow(workflow) && workflow.starts !== undefined)
      throw new ClientError(
        "no-id",
        `a run of ${name}, which starts on events, is named by its senders: start(${name}, args, { id }), or an id(args) on the workflow`,
      );
    return undefined;
  }
  let id: unknown;
  try {
    id = workflow.id(args as never);
  } catch (error) {
    throw new ClientError("prepare", `${name}'s id(args) failed: ${messageOf(error)}`);
  }
  const problem = typeof id === "string" ? idProblem(id) : `it returned a ${typeof id}`;
  if (problem) throw new ClientError("id", `${name}'s id(args): ${problem}`);
  return id as string;
}

export function checkRunId(id: string, ref: string): void {
  const problem = idProblem(id);
  if (problem) throw new ClientError("id", `the run's id: ${problem}`, ref);
}

/** A cursor is an item's, never an option of the command it is read with. */
export function checkCursor(after: unknown): void {
  if (after !== undefined && (typeof after !== "string" || after === "" || after.startsWith("-")))
    throw new ClientError("cursor", `${JSON.stringify(after)} is no cursor an item carried`);
}
