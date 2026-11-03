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
 * Where an asker may wait for an answer, by harness and placement: on where M2 passed
 * (`docs/findings/messaging-m2.md`), off elsewhere. A TUI that is `confirmed` waits only where it
 * confirms what it was sent, as `wfa waiting` needs. The fake harness always may. cursor is off:
 * its turns ran past their deadline in M2.
 */
export const AWAIT_REPLY: Readonly<Record<string, { headless?: true; tui?: true | "confirmed" }>> =
  {
    fake: { headless: true, tui: true },
    claude: { headless: true, tui: "confirmed" },
    codex: { headless: true },
    pi: { headless: true },
  };

/** Whether this agent may `--await-reply` where it runs. */
export function canAwaitReply(
  execution: AgentExecution,
  confirmsDelivery: boolean,
  list: typeof AWAIT_REPLY = AWAIT_REPLY,
): boolean {
  const allowed = list[execution.harness]?.[placementOf(execution)];
  return allowed === true || (allowed === "confirmed" && confirmsDelivery);
}
