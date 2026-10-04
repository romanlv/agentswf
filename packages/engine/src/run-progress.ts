import type { StageOutcome } from "@agentswf/contract/records";
import type { AgentKey, JsonValue, TurnOutcome } from "@agentswf/contract/workflow";

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

/** One workflow stage this attempt entered: run, or reused from the attempt that ran it. */
export type StageProgress = {
  name: string;
  source: "ran" | "reused";
  /** For a reused stage, the attempt that ran it. */
  attempt?: number;
  startedAt: number;
  endedAt?: number;
  /** Absent while it runs. */
  outcome?: StageOutcome;
  summary?: string;
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

/** What the engine knows about a run's progress beyond each agent's harness state. */
export class RunProgress {
  readonly #groups: GroupProgress[] = [];
  readonly #stages: StageProgress[] = [];
  readonly #agents = new Map<AgentKey, AgentProgress>();
  /** Stages an earlier attempt recorded, in the order it ran them: what may still come. */
  #recorded: string[] = [];

  group(label: string, total: number): GroupProgress {
    const group = { label, total, started: 0, done: 0, startedAt: Date.now() };
    this.#groups.push(group);
    return group;
  }

  recorded(stages: readonly string[]): void {
    this.#recorded = [...stages];
  }

  stageEntered(name: string, source: "ran" | "reused", attempt?: number, summary?: string): void {
    const now = Date.now();
    this.#stages.push({
      name,
      source,
      ...(attempt === undefined ? {} : { attempt }),
      startedAt: now,
      ...(source === "reused" ? { endedAt: now, outcome: "succeeded" as const } : {}),
      ...(summary === undefined ? {} : { summary }),
    });
  }

  stageEnded(name: string, outcome: StageOutcome, summary?: string): void {
    const stage = this.#stages.findLast((entered) => entered.name === name);
    if (!stage || stage.endedAt !== undefined) return;
    stage.endedAt = Date.now();
    stage.outcome = outcome;
    if (summary !== undefined) stage.summary = summary;
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

  turnStarted(key: AgentKey, tags: { stage?: string; label?: string } = {}): void {
    const agent = this.#agents.get(key);
    if (!agent) return;
    agent.turns += 1;
    agent.turn = { startedAt: Date.now(), ...tags };
  }

  turnSettled(key: AgentKey, outcome: TurnProgress["outcome"], reason?: string): void {
    const turn = this.#agents.get(key)?.turn;
    if (!turn || turn.outcome) return;
    turn.settledAt = Date.now();
    turn.outcome = outcome;
    if (reason !== undefined) turn.reason = reason;
  }

  snapshot(): {
    groups: GroupProgress[];
    stages: StageProgress[];
    upcoming: string[];
    agents: Map<AgentKey, AgentProgress>;
  } {
    const entered = new Set(this.#stages.map((stage) => stage.name));
    return {
      groups: structuredClone(this.#groups),
      stages: structuredClone(this.#stages),
      upcoming: this.#recorded.filter((name) => !entered.has(name)),
      agents: structuredClone(this.#agents),
    };
  }
}
