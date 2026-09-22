import type {
  AgentExecution,
  AgentKey,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  AbsoluteDeadline,
  CompactionId,
  HarnessKind,
  NudgeOptions,
  RuntimeAliases,
  SkillName,
  TurnId,
} from "@wf/contract/workflow";
import type { JsonObject, JsonValue } from "@wf/contract/workflow";
import type { TurnUsage as NativeUsageSample } from "./spec";

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
 * Where an operation's result goes. Nothing here is secret: the agent reaches the control plane
 * over a socket only it can open, so the authority is the connection rather than anything a
 * harness has to carry into the agent's environment.
 */
export type HarnessOperationBinding = {
  endpoint: string;
  operationId: string;
};

export type HarnessResultEvidence =
  | { kind: "transcript"; text: string }
  | { kind: "unavailable" };

export type HarnessTurnOutcome = {
  state: "completed" | "blocked" | "timed-out" | "failed" | "cancelled";
  detail?: string;
  resultEvidence: HarnessResultEvidence;
  nativeUsage: readonly NativeUsageSample[];
};

export type HarnessReleaseDisposition =
  | { kind: "released"; outcome: HarnessTurnOutcome }
  | { kind: "quarantined"; reason: string };

export interface HarnessTurn {
  /** Native evidence only; the engine combines it with the atomically settled result slot. */
  readonly settled: Promise<HarnessTurnOutcome>;
  /** Continues this operation and resolves once the prompt is presented to the model. */
  deliver(prompt: string): Promise<void>;
  /** Makes one more delivery attempt using this operation's existing result authority. */
  nudge(spec: HarnessNudgeSpec): Promise<HarnessTurn>;
  /** Requests termination and distinguishes observed release from unresolved native work. */
  release(reason: string, deadline: AbsoluteDeadline): Promise<HarnessReleaseDisposition>;
}

export interface HarnessSession {
  /** Capabilities of this activated harness/backend pair. */
  readonly capabilities: {
    nativeFork: false | NativeForkCapability;
  };
  status(): Promise<HarnessSessionStatus>;
  start(turn: AgentTextTurnSpec, binding: HarnessOperationBinding): Promise<HarnessTurn>;
  start<T extends JsonValue>(
    turn: AgentStructuredTurnSpec<T>,
    binding: HarnessOperationBinding,
  ): Promise<HarnessTurn>;
  compact(id: CompactionId, prompt: string, deadline: AbsoluteDeadline): Promise<HarnessTurn>;
  close(reason?: string): Promise<void>;
}

export interface NativeForkCapability {
  /** A harness-native primitive only; the engine must assign any resulting logical identity. */
  fork(deadline: AbsoluteDeadline): Promise<HarnessSession>;
}

export interface HarnessActivation {
  key: AgentKey;
  deadline: AbsoluteDeadline;
  cwd: string;
  instructions?: string;
  skills?: readonly SkillName[];
  labels?: JsonObject;
  execution: AgentExecution;
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
}

/** Engine-owned configuration assembled once, outside workflow definitions. */
export interface AgentRuntimeConfig {
  aliases: RuntimeAliases;
  /** Exactly one host owns placement, inspection, continuation, and cleanup for this run. */
  host: AgentRunHostFactory;
}
