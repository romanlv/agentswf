import type { WaitTake } from "@agentswf/contract/records";
import type { JsonValue, WorkflowEvent } from "@agentswf/contract/workflow";
import { matches, recordName } from "./run-policy/waits";

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

/** `event` under the name the workflow declares for it, where it declares one. */
export function presented<E extends WorkflowEvent<string, JsonValue>>(
  event: E,
  declared: ReadonlySet<string>,
): E {
  const kind = { "agent:ended": "ended", "participant:reply": "reply" }[event.name as string];
  if (kind === undefined || !declared.has(`${event.from}:${kind}`)) return event;
  return Object.freeze({ ...event, name: `${event.from}:${kind}` });
}

/** What a source takes; undefined for anything the run didn't issue as one. */
export function takeOf(value: unknown): WaitTake | undefined {
  return typeof value === "object" && value !== null ? takes.get(value) : undefined;
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
