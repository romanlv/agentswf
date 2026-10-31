import type { WaitTake } from "@agentswf/contract/records";
import type { JsonValue, WorkflowEvent } from "@agentswf/contract/workflow";

/** What each source the run issued takes: only awf makes a source, so only these are. */
const takes = new WeakMap<object, WaitTake>();

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

type Looked = { name: string; from: string; data?: unknown };

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

/** Whether a wait that takes `take` takes `event`. */
export function matches(
  event: { name: string; from: string; data?: unknown },
  take: WaitTake,
): boolean {
  if (event.name !== take.name) return false;
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
 * and arrival, and a workflow's own event whole.
 */
export function branchValue(event: WorkflowEvent<string, JsonValue>): unknown {
  switch (event.name) {
    case "timer:due":
    case "at:due":
    case "participant:reply":
    case "agent:ended":
      return Object.freeze({ ...(event.data as object), id: event.id, at: event.at });
    default:
      return event;
  }
}
