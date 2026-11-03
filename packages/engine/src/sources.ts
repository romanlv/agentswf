import type { WaitTake } from "@agentswf/contract/records";
import { awfEventOf, type JsonValue, type WorkflowEvent } from "@agentswf/contract/workflow";

/** What each source the run issued takes: only awf makes a source, so only these are. */
const takes = new WeakMap<object, WaitTake>();

/** Signals: a branch on one hands back the whole event, not its data. */
const signals = new WeakSet<object>();

/** Marks `value` as a source that takes `take`, and returns it. */
export function asSource<T extends object>(value: T, take: WaitTake): T {
  takes.set(value, take);
  return value;
}

/** A source of `fields` that takes `take`, its `is(e)` the test its waits use. */
export function source<T extends object>(
  fields: T,
  take: WaitTake,
): T & { is(event: Looked): boolean } {
  return asSource(Object.freeze({ ...fields, is: (event: Looked) => matches(event, take) }), take);
}

/** As `source`, for a signal. */
export function signalOf<T extends object>(fields: T, take: WaitTake): T {
  const made = source(fields, take);
  signals.add(made);
  return made;
}

/** Whether `value` is a signal, whose branch hands back the whole event. */
export function isSignal(value: unknown): boolean {
  return typeof value === "object" && value !== null && signals.has(value);
}

type Looked = { name: string; from: string; data?: unknown };

/**
 * The name the mailbox records an event under: awf's keep `agent:ended` and `participant:reply`,
 * from their key, whatever name the workflow declares and is handed, `{key}:ended` or `{key}:reply`.
 */
export function recordName(event: { name: string; from: string }): string {
  const awf = awfEventOf(event.name);
  if (!awf || awf.key !== event.from) return event.name;
  return awf.kind === "ended" ? "agent:ended" : "participant:reply";
}

/** `event` under the name the workflow declares for it, where it declares one. */
export function presented<E extends WorkflowEvent<string, JsonValue>>(
  event: E,
  declared: ReadonlySet<string>,
): E {
  const kind = { "agent:ended": "ended", "participant:reply": "reply" }[event.name as string];
  if (kind === undefined || !declared.has(`${event.from}:${kind}`)) return event;
  return Object.freeze({ ...event, name: `${event.from}:${kind}` });
}

/** The first of `branches` that takes `event`. */
export function branchOf(
  branches: readonly (readonly [string, WaitTake])[],
  event: Looked,
): string | undefined {
  return branches.find(([, take]) => matches(event, take))?.[0];
}

/** What a source takes; undefined for anything the run didn't issue as one. */
export function takeOf(value: unknown): WaitTake | undefined {
  return typeof value === "object" && value !== null ? takes.get(value) : undefined;
}

/** Whether a wait that takes `take` takes `event`, under its recorded name or its declared one. */
export function matches(
  event: { name: string; from: string; data?: unknown },
  take: WaitTake,
): boolean {
  if (recordName(event) !== take.name) return false;
  if (take.from !== undefined && event.from !== take.from) return false;
  if (take.turn === undefined) return true;
  const data = event.data as { turn?: unknown } | null | undefined;
  return typeof data === "object" && data !== null && data.turn === take.turn;
}

/** Whether a wait taking `wanted`, or everything when it names nothing, takes `event`. */
export function wouldTake(
  event: { name: string; from: string; data?: unknown },
  wanted: readonly WaitTake[] | undefined,
): boolean {
  return wanted === undefined || wanted.some((take) => matches(event, take));
}

/**
 * What a branch hands back of the event it took: awf's own events as their data with the event's id
 * and arrival, and a workflow's own event, or any a signal takes, whole.
 */
export function branchValue(event: WorkflowEvent<string, JsonValue>, whole = false): unknown {
  if (whole) return event;
  switch (recordName(event)) {
    case "timer:due":
    case "at:due":
    case "participant:reply":
    case "agent:ended":
      return Object.freeze({ ...(event.data as object), id: event.id, at: event.at });
    default:
      return event;
  }
}
