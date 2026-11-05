import type { RunLine } from "@agentswf/contract/records";
import type { AgentExecution, OperationRecord } from "@agentswf/contract/workflow";
import { endIdOf } from "./event-ids";
import type { TurnStartedLine } from "./run-policy/waits";

/** The usage of a turn no delivery settled: one refused, cancelled while queued, or cut off by a crash. */
export function unrunUsage(
  agent: string,
  operationId: string,
  execution: AgentExecution,
): OperationRecord {
  return { callPath: [], agent, operationId, execution, sessions: [] };
}

/** The failed `turn-ended` attempt `attempt`'s claim writes for `turn`, which its attempt left running. */
export function crashedEnd(turn: TurnStartedLine, attempt: number, at: string): RunLine {
  return {
    kind: "turn-ended",
    attempt,
    at,
    id: endIdOf(turn.agent, turn.turn, turn.attempt),
    agent: turn.agent,
    turn: turn.turn,
    began: turn.attempt,
    end: {
      turn: turn.turn,
      meta: turn.meta,
      outcome: {
        answered: false,
        kind: "failed",
        reason: `attempt ${turn.attempt} ended before this turn did; its work, if any, is in the agent's session`,
        retryable: true,
        usage: unrunUsage(turn.agent, turn.turn, turn.execution),
      },
    },
  };
}
