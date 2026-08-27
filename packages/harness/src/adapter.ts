import type {
  AgentExecution,
  AgentKey,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  BackendKind,
  CompactionId,
  HarnessKind,
  NudgeOptions,
  RuntimeAliases,
  SkillName,
  TurnId,
  TurnOutcome,
} from "@wf/contract/workflow";
import type { JsonObject, JsonValue } from "@wf/contract/workflow";

export type AgentState =
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "dormant"
  | "missing"
  | "unknown";

export interface HarnessSessionIdentity extends AgentExecution {
  sessionId: string;
  cwd: string;
}

export interface HarnessSessionStatus {
  state: AgentState;
  detail?: string;
}

export interface HarnessNudgeSpec extends NudgeOptions {
  id: TurnId;
}

export interface HarnessTurn<T extends JsonValue> {
  /** Reconciles callback and session evidence; transport acceptance alone is not delivery. */
  readonly result: Promise<TurnOutcome<T>>;
  /** Continues this operation and resolves once the prompt is presented to the model. */
  deliver(prompt: string): Promise<void>;
  nudge(spec: HarnessNudgeSpec): Promise<HarnessTurn<T>>;
  cancel(reason?: string): Promise<boolean>;
}

export interface HarnessSession {
  readonly identity: HarnessSessionIdentity;
  status(): Promise<HarnessSessionStatus>;
  start(turn: AgentTextTurnSpec): Promise<HarnessTurn<string>>;
  start<T extends JsonValue>(turn: AgentStructuredTurnSpec<T>): Promise<HarnessTurn<T>>;
  /** Applies the returned summary only when the outcome is `answered`. */
  compact(id: CompactionId, prompt: string): Promise<TurnOutcome<string>>;
  close(reason?: string): Promise<void>;
}

export interface HarnessActivation {
  key: AgentKey;
  cwd: string;
  instructions?: string;
  skills?: readonly SkillName[];
  labels?: JsonObject;
  execution: AgentExecution;
  previousSessionId?: string;
}

export interface AgentHarnessAdapter {
  readonly kind: HarnessKind;
  readonly backends: readonly [BackendKind, ...BackendKind[]];
  activate(request: HarnessActivation): Promise<HarnessSession>;
}

/** Engine-owned configuration assembled once, outside workflow definitions. */
export interface AgentRuntimeConfig {
  aliases: RuntimeAliases;
  harnesses: readonly AgentHarnessAdapter[];
}
