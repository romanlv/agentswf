import { AsyncLocalStorage } from "node:async_hooks";
import { type AgentOpenSpec, positiveDurationMilliseconds } from "@agentswf/contract/workflow";

/** `keepAlive` as the engine keeps it: its window in milliseconds. */
export type KeepAlive = {
  windowMs?: number;
  onTimeout?: NonNullable<AgentOpenSpec["keepAlive"]>["onTimeout"];
};

/** Claude's prompt cache lives an hour for the main conversation on a subscription. */
export const DEFAULT_WINDOW_MS = 60 * 60_000;

/**
 * Set while an `onTimeout` handler runs: a turn begun in it opens no window, so a wrap-up can't keep
 * its own agent live. A message turn opens one whatever the context: it is the peer's.
 */
const inHandler = new AsyncLocalStorage<boolean>();

export function inTimeoutHandler(): boolean {
  return inHandler.getStore() === true;
}

export function asTimeoutHandler<T>(fn: () => T): T {
  return inHandler.run(true, fn);
}

/** `keepAlive` as an open gave it, checked: a plain caller can get wrong what a typed one can't. */
export function checkedKeepAlive(key: string, given: unknown): KeepAlive {
  if (typeof given !== "object" || given === null)
    throw new Error(`agent ${key}: keepAlive is { window?, onTimeout? }`);
  const { window, onTimeout } = given as Record<string, unknown>;
  const windowMs =
    window == null
      ? undefined
      : positiveDurationMilliseconds(window, `agent ${key}: keepAlive's window`);
  if (onTimeout !== undefined && typeof onTimeout !== "function")
    throw new Error(`agent ${key}: keepAlive's onTimeout is a function`);
  // A copy: a later change to the caller's object would skip this check.
  return {
    ...(windowMs === undefined ? {} : { windowMs }),
    ...(onTimeout === undefined ? {} : { onTimeout: onTimeout as KeepAlive["onTimeout"] }),
  };
}
