import type { MessageLimits } from "@agentswf/contract/records";
import type { AgentExecution } from "@agentswf/contract/workflow";
import { placementOf } from "@agentswf/contract/workflow";

/** The ceilings an attempt runs under, written into its record; a route may only lower `perRoute`. */
export const MESSAGE_LIMITS: MessageLimits = {
  perRoute: 40,
  bytes: 16 * 1024,
  unread: 16,
  operationMs: 15 * 60_000,
};

/**
 * Where an asker may wait for an answer, by harness and placement: off until M2 passes there
 * (story 029's M2 gate). The fake harness always may.
 */
export const AWAIT_REPLY: Readonly<Record<string, { headless?: true; pane?: true }>> = {
  fake: { headless: true, pane: true },
};

/**
 * Whether this agent may `--await-reply`: on the list for its harness and placement, and, in a
 * pane, only where the pane confirms what it was sent, as `wf waiting` needs.
 */
export function canAwaitReply(
  execution: AgentExecution,
  confirmsDelivery: boolean,
  list: typeof AWAIT_REPLY = AWAIT_REPLY,
): boolean {
  const placement = placementOf(execution);
  const allowed = list[execution.harness]?.[placement] === true;
  return allowed && (placement === "headless" || confirmsDelivery);
}
