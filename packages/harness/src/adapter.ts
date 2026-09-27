import type {
  AbsoluteDeadline,
  AgentExecution,
  AgentKey,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  CompactionId,
  HarnessKind,
  JsonObject,
  JsonValue,
  NudgeOptions,
  RuntimeAliases,
  TurnId,
} from "@wf/contract/workflow";
import type { Occupant } from "@wf/sandbox";
import type { AgentSkills } from "./capabilities/skills";
import type { SessionAccounting } from "./usage/accounting";

export type AgentState =
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "dormant"
  | "quarantined"
  | "missing"
  | "unknown";

export interface HarnessSessionStatus {
  state: AgentState;
  detail?: string;
}

export interface HarnessNudgeSpec extends NudgeOptions {
  id: TurnId;
}

/**
 * Which call this turn answers. Nothing here is secret: the agent reaches the control plane over a
 * socket only it can open, so the authority is the connection rather than anything a harness has
 * to carry into the agent's environment.
 */
export type HarnessOperationBinding = {
  /**
   * The socket this operation's result goes to. A production adapter never reads it — the prompt
   * names a launcher that already points there — only a test adapter playing the agent does.
   */
  endpoint: string;
  operationId: string;
};

export type HarnessResultEvidence = { kind: "transcript"; text: string } | { kind: "unavailable" };

export type HarnessTurnOutcome = {
  state: "completed" | "blocked" | "timed-out" | "failed" | "cancelled";
  detail?: string;
  resultEvidence: HarnessResultEvidence;
  /** The dollars the harness printed for each native turn behind this outcome. */
  chargesUsd: readonly number[];
};

export type HarnessReleaseDisposition =
  | { kind: "released"; outcome: HarnessTurnOutcome }
  /**
   * Answered and left to end on its own, so the session a follow-up resumes is whole. Its outcome
   * arrives through the turn's `settled`. The host stops it after a bounded grace, the session's
   * next start waits for it, and close ends it.
   */
  | { kind: "finishing" }
  | { kind: "quarantined"; reason: string };

export interface HarnessTurn {
  /** Native evidence only; the engine combines it with the atomically settled result slot. */
  readonly settled: Promise<HarnessTurnOutcome>;
  /** Continues this operation and resolves once the prompt is presented to the model. */
  deliver(prompt: string): Promise<void>;
  /** Makes one more delivery attempt using this operation's existing result authority. */
  nudge(spec: HarnessNudgeSpec): Promise<HarnessTurn>;
  /**
   * Requests termination and distinguishes observed release from unresolved native work. An
   * answered turn on a session that continues may instead be left to finish.
   */
  release(
    reason: string,
    deadline: AbsoluteDeadline,
    options?: HarnessReleaseOptions,
  ): Promise<HarnessReleaseDisposition>;
}

export type HarnessReleaseOptions = {
  /**
   * The operation's result is in. A host whose next operation resumes this session may answer
   * `finishing` instead of stopping the turn; one that ignores this stops it, which is safe.
   */
  answered?: boolean;
};

export interface HarnessSession {
  status(): Promise<HarnessSessionStatus>;
  start(turn: AgentTextTurnSpec, binding: HarnessOperationBinding): Promise<HarnessTurn>;
  start<T extends JsonValue>(
    turn: AgentStructuredTurnSpec<T>,
    binding: HarnessOperationBinding,
  ): Promise<HarnessTurn>;
  compact(id: CompactionId, prompt: string, deadline: AbsoluteDeadline): Promise<HarnessTurn>;
  close(reason?: string): Promise<void>;
  /** Every native session id the adapter has seen for this agent, in the order first seen. */
  sessions?(): readonly string[];
}

export interface HarnessActivation {
  key: AgentKey;
  deadline: AbsoluteDeadline;
  cwd: string;
  instructions?: string;
  labels?: JsonObject;
  execution: AgentExecution;
  /**
   * The agent's place in a sandbox: every process it runs goes through `occupant.launch`. An
   * adapter that cannot launch through one refuses the agent.
   */
  occupant?: Occupant;
  /**
   * The skills the workflow named, copied where this harness reads them. Absent, the harness finds
   * whatever it would on its own.
   */
  skills?: AgentSkills;
}

/** An opaque locator for a session the engine did not start; only the adapter interprets it. */
export type OutsideSessionHandle = string;

export interface OutsideSessionControl {
  status(session: OutsideSessionHandle): Promise<HarnessSessionStatus>;
  /**
   * Causes the session to take a turn. It carries no message — content stays in the inbox — so a
   * lost wake costs nothing and is retried against `status` rather than confirmed by this call.
   */
  wake(session: OutsideSessionHandle): Promise<void>;
}

export interface AgentSessionAdapter {
  readonly harnesses: readonly [HarnessKind, ...HarnessKind[]];
  readonly capabilities: {
    outsideWake: boolean;
  };
  activate(request: HarnessActivation): Promise<HarnessSession>;
  /** Present only when the adapter advertises `outsideWake`; never a logical-agent operation. */
  readonly outside?: OutsideSessionControl;
}

export type HarnessRunSpec = {
  runId: string;
  cwd: string;
  deadline: AbsoluteDeadline;
};

export type HarnessAgentSnapshot = {
  key: AgentKey;
  execution: AgentExecution;
  state: AgentState;
  observedAt: number;
  detail?: string;
};

export type HarnessRunSnapshot = {
  state: "starting" | "running" | "closing" | "closed";
  agents: readonly HarnessAgentSnapshot[];
};

export interface AgentRunHost {
  openAgent(request: HarnessActivation): Promise<HarnessSession>;
  inspect(): HarnessRunSnapshot;
  close(reason?: string): Promise<void>;
}

export interface AgentRunHostFactory {
  openRun(request: HarnessRunSpec): Promise<AgentRunHost>;
  /**
   * How this host's agents are billed and where their spend is read. It belongs to the host,
   * because how an agent is launched decides who pays. Absent, nothing is read.
   */
  readonly accounting?: SessionAccounting;
}

/** Engine-owned configuration assembled once, outside workflow definitions. */
export interface AgentRuntimeConfig {
  aliases: RuntimeAliases;
  /**
   * Exactly one host serves every agent's placement and owns inspection, continuation, and cleanup
   * for this run.
   */
  host: AgentRunHostFactory;
}
