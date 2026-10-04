import type { AgentKey, JsonValue, TurnOutcome } from "@agentswf/contract/workflow";
import type { OperationTags } from "./run-usage";

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

export type TurnProgress = {
  startedAt: number;
  settledAt?: number;
  /** Absent while the turn runs. */
  outcome?: TurnOutcome<JsonValue>["kind"];
  reason?: string;
  /** The workflow stage it runs in, and the label the workflow gave it. */
  stage?: string;
  label?: string;
  /** Present for a compaction, which has no label of its own. */
  kind?: "compact";
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

  turnStarted(key: AgentKey, tags: OperationTags = {}, kind: "turn" | "compact" = "turn"): void {
    const agent = this.#agents.get(key);
    if (!agent) return;
    agent.turns += 1;
    agent.turn = { startedAt: Date.now(), ...tags, ...(kind === "compact" ? { kind } : {}) };
  }

  turnSettled(key: AgentKey, outcome: TurnProgress["outcome"], reason?: string): void {
    const turn = this.#agents.get(key)?.turn;
    if (!turn || turn.outcome) return;
    turn.settledAt = Date.now();
    turn.outcome = outcome;
    if (reason !== undefined) turn.reason = reason;
  }

  snapshot(): { groups: GroupProgress[]; agents: Map<AgentKey, AgentProgress> } {
    return { groups: structuredClone(this.#groups), agents: structuredClone(this.#agents) };
  }
}
