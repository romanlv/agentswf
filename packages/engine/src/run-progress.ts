import type { AgentKey, JsonValue, TurnOutcome } from "@wf/contract/workflow";

/** One labelled `parallel` call. Its label need not be unique; its position is. */
export type StageProgress = {
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
};

export type AgentProgress = {
  /** Index into `stages` of the stage that opened the agent. */
  stage?: number;
  turns: number;
  /** The latest turn. */
  turn?: TurnProgress;
};

/** What the engine knows about a run's progress beyond each agent's harness state. */
export class RunProgress {
  readonly #stages: StageProgress[] = [];
  readonly #agents = new Map<AgentKey, AgentProgress>();

  stage(label: string, total: number): StageProgress {
    const stage = { label, total, started: 0, done: 0, startedAt: Date.now() };
    this.#stages.push(stage);
    return stage;
  }

  agentOpened(key: AgentKey, stage: StageProgress | undefined): void {
    if (this.#agents.has(key)) return;
    const index = stage ? this.#stages.indexOf(stage) : -1;
    this.#agents.set(key, { turns: 0, ...(index >= 0 ? { stage: index } : {}) });
  }

  turnStarted(key: AgentKey): void {
    const agent = this.#agents.get(key);
    if (!agent) return;
    agent.turns += 1;
    agent.turn = { startedAt: Date.now() };
  }

  turnSettled(key: AgentKey, outcome: TurnProgress["outcome"], reason?: string): void {
    const turn = this.#agents.get(key)?.turn;
    if (!turn || turn.outcome) return;
    turn.settledAt = Date.now();
    turn.outcome = outcome;
    if (reason !== undefined) turn.reason = reason;
  }

  snapshot(): { stages: StageProgress[]; agents: Map<AgentKey, AgentProgress> } {
    return { stages: structuredClone(this.#stages), agents: structuredClone(this.#agents) };
  }
}
