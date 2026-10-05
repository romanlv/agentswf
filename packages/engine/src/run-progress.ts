import type { TurnRecord } from "@agentswf/contract/records";
import type { AgentKey, OperationRecord } from "@agentswf/contract/workflow";

/** One labelled `parallel` call. Its label need not be unique; its position is. */
export type GroupProgress = {
  label: string;
  total: number;
  /** Items handed to the operation so far; the rest wait for a free slot. */
  started: number;
  done: number;
  startedAt: number;
  endedAt?: number;
};

type TurnProgress = Pick<TurnRecord, "kind" | "stage" | "label"> & {
  startedAt: number;
  phase?: string;
  waitingReason?: string;
  checkInAt?: number;
  settledAt?: number;
  /** Absent while the turn runs. */
  outcome?: TurnRecord["outcome"];
  reason?: string;
};

export type AgentProgress = {
  /** Index into `groups` of the labelled `parallel` that opened the agent. */
  group?: number;
  turns: number;
  /** The agent it was forked from. */
  forkedFrom?: AgentKey;
  /** The latest turn. */
  turn?: TurnProgress;
};

/**
 * What the engine knows about a run's progress beyond each agent's harness state and the stages,
 * which the stage ledger keeps.
 */
export class RunProgress {
  readonly #groups: GroupProgress[] = [];
  readonly #agents = new Map<AgentKey, AgentProgress>();

  group(label: string, total: number): GroupProgress {
    const group = { label, total, started: 0, done: 0, startedAt: Date.now() };
    this.#groups.push(group);
    return group;
  }

  agentOpened(key: AgentKey, group: GroupProgress | undefined): void {
    if (this.#agents.has(key)) return;
    const index = group ? this.#groups.indexOf(group) : -1;
    this.#agents.set(key, { turns: 0, ...(index >= 0 ? { group: index } : {}) });
  }

  /** A fork that was not made, whose key is free again. */
  agentDropped(key: AgentKey): void {
    this.#agents.delete(key);
  }

  /** Once its parent's session was copied, not when it was asked for. */
  agentForked(key: AgentKey, from: AgentKey): void {
    const agent = this.#agents.get(key);
    if (agent) agent.forkedFrom = from;
  }

  turnStarted(
    key: AgentKey,
    tags: Pick<OperationRecord, "stage" | "label"> = {},
    kind: TurnRecord["kind"] = "turn",
  ): void {
    const agent = this.#agents.get(key);
    if (!agent) return;
    agent.turns += 1;
    agent.turn = { kind, startedAt: Date.now(), ...tags };
  }

  turnSettled(key: AgentKey, outcome: TurnProgress["outcome"], reason?: string): void {
    const turn = this.#agents.get(key)?.turn;
    if (!turn || turn.outcome) return;
    turn.settledAt = Date.now();
    turn.outcome = outcome;
    if (reason !== undefined) turn.reason = reason;
  }

  turnPhase(key: AgentKey, phase: string, reason?: string, until?: number): void {
    const turn = this.#agents.get(key)?.turn;
    if (!turn || turn.outcome) return;
    turn.phase = phase;
    turn.waitingReason = reason;
    turn.checkInAt = until;
  }

  snapshot(): { groups: GroupProgress[]; agents: Map<AgentKey, AgentProgress> } {
    return { groups: structuredClone(this.#groups), agents: structuredClone(this.#agents) };
  }
}
