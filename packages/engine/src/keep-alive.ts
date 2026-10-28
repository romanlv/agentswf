import { AsyncLocalStorage } from "node:async_hooks";
import type { EventAgentOpenSpec } from "@agentswf/contract/workflow";

export type KeepAlive = NonNullable<EventAgentOpenSpec["keepAlive"]>;

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

/** `keepAlive` as an open gave it, checked: what a typed caller can't get wrong, a plain one can. */
export function checkedKeepAlive(key: string, given: unknown): KeepAlive {
  if (typeof given !== "object" || given === null)
    throw new Error(`agent ${key}: keepAlive is { timeoutMs?, onTimeout? }`);
  const { timeoutMs, onTimeout } = given as Record<string, unknown>;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  )
    throw new Error(`agent ${key}: keepAlive's timeoutMs is a positive number of milliseconds`);
  if (onTimeout !== undefined && typeof onTimeout !== "function")
    throw new Error(`agent ${key}: keepAlive's onTimeout is a function`);
  // A copy: a later change to the caller's object would skip this check.
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onTimeout === undefined ? {} : { onTimeout: onTimeout as KeepAlive["onTimeout"] }),
  } as KeepAlive;
}
