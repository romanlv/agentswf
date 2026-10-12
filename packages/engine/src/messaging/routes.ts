import type { RouteEnds } from "@agentswf/contract/records";
import type { AgentKey } from "@agentswf/contract/workflow";

/**
 * Where routes live and when they close: a stage's scope, or the attempt's. A scope is `finishing`
 * once its function has returned, while it waits for what it owns: new messages on its routes are
 * refused then, though a plain answer still goes.
 */
export type Scope = {
  readonly id: number;
  /** The stage it is; absent for the attempt's. */
  readonly stage?: string;
  state: "open" | "finishing" | "closed";
};

export type Route = {
  readonly ends: RouteEnds;
  readonly purpose: string;
  readonly maxMessages: number;
  /** What the workflow asked for, when the ceiling lowered it. */
  readonly asked?: number;
  /** As the workflow gave it, for telling an identical grant from a conflicting one. */
  readonly requested?: number;
  readonly scope: Scope;
  /** Messages counted against it, answers reserved for included. */
  count: number;
  open: boolean;
  /** Why it closed. */
  closed?: "stage-ended" | "agent-stopped" | "attempt-ended";
  /** Its place among the attempt's grants, which `wf peers` lists in. */
  readonly order: number;
};

/** The ordered pairs a route carries messages for: one, or `between`'s two. */
export function directions(ends: RouteEnds): [AgentKey, AgentKey][] {
  return ends.between
    ? [
        [ends.between[0], ends.between[1]],
        [ends.between[1], ends.between[0]],
      ]
    : [[ends.from, ends.to]];
}

export function pairKey(from: AgentKey, to: AgentKey): string {
  return JSON.stringify([from, to]);
}

/** The other end, for `agent`, one of its ends. */
export function peerOf(route: Route, agent: AgentKey): AgentKey {
  const [a, b] = route.ends.between ?? [route.ends.from, route.ends.to];
  return a === agent ? b : a;
}

/** The same grant: shape, purpose, requested limit and scope, `between`'s order aside. */
export function sameGrant(
  route: Route,
  ends: RouteEnds,
  purpose: string,
  requested: number | undefined,
  scope: Scope,
): boolean {
  const sameEnds = route.ends.between
    ? ends.between !== undefined &&
      [...route.ends.between].sort().join("\0") === [...ends.between].sort().join("\0")
    : ends.between === undefined && route.ends.from === ends.from && route.ends.to === ends.to;
  return (
    sameEnds && route.purpose === purpose && route.requested === requested && route.scope === scope
  );
}

/** A route's purpose: one line, at most 200 characters, no control characters. */
export function purposeProblem(purpose: unknown): string | undefined {
  if (typeof purpose !== "string" || purpose.trim() === "") return "a route needs a purpose";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\u0000-\u001f\u007f]/.test(purpose))
    return "a route's purpose is one line with no control characters";
  if ([...purpose].length > 200) return "a route's purpose is at most 200 characters";
  return undefined;
}
