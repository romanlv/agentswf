import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { ParticipantRef } from "./participants";

export type AgentKey = string;
export type SkillName = string;
export type RuntimeAliasName = string;
export type TurnId = string;
export type CompactionId = string;
export type HarnessKind = string;
export type BackendKind = "pane" | "headless";
export type SpendPoolKey = string;

export type ModelSettings = {
  /** Harness-defined reasoning effort, such as `low`, `medium`, or `high`. */
  effort?: string;
  /** Positive maximum number of generated tokens. */
  maxOutputTokens?: number;
  /** Additional model-provider settings, validated by the selected harness. */
  providerOptions?: JsonObject;
};

export type ExecutionConfig = {
  harness: HarnessKind;
  model: string;
  backend: BackendKind;
  pool: SpendPoolKey;
  settings?: ModelSettings;
};

/** A centrally configured name for an execution configuration. */
export type RuntimeAliases = Readonly<Record<RuntimeAliasName, ExecutionConfig>>;

export type RetentionPolicy =
  | { kind: "workflow" }
  | {
      kind: "idle";
      /** Positive retention duration after becoming idle. */
      milliseconds: number;
    }
  | { kind: "explicit" };

/** Recovery retries the in-flight turn under its existing id; exhaustion resolves as `failed`. */
export type RecoveryPolicy =
  | { onCrash: "fail" }
  | {
      onCrash: "resume";
      /** Non-negative restart limit. */
      maxRestarts: number;
    }
  | {
      /** Starts a fresh session with the same execution if resume is unavailable. */
      onCrash: "resume-or-replace";
      /** Non-negative restart limit. */
      maxRestarts: number;
    };

export interface AgentLifecycle {
  retention: RetentionPolicy;
  recovery?: RecoveryPolicy;
}

export type ExecutionRequirements = {
  /** Alias resolution happens first; every other supplied field must then match exactly. */
  alias: RuntimeAliasName;
  harness?: HarnessKind;
  model?: string;
  backend?: BackendKind;
  pool?: SpendPoolKey;
  /** Exact structural match, including provider options. */
  settings?: ModelSettings;
};

/** An alias, constrained alias, or complete execution configuration. */
export type RuntimeSelection = RuntimeAliasName | ExecutionRequirements | ExecutionConfig;

export type AgentExecution = ExecutionConfig & {
  /** Present when this execution was selected through an alias. */
  alias?: RuntimeAliasName;
};

export type UsageExecution = Omit<AgentExecution, "settings">;

export interface AgentOpenSpec {
  key: AgentKey;
  /** Defaults to the workflow's working directory. */
  cwd?: string;
  instructions?: string;
  /** Defaults to workflow retention with no crash recovery. */
  lifecycle?: AgentLifecycle;
  /** Selects the harness and model. */
  runtime: RuntimeSelection;
  /** Harness-neutral skill names made available to this logical agent. */
  skills?: readonly SkillName[];
  labels?: JsonObject;
}

interface AgentTurnBase {
  prompt: string;
  label?: string;
}

export interface NudgeOptions {
  /** Uses the engine's standard missing-answer recovery prompt when omitted. */
  prompt?: string;
}

interface EnqueuedTurnBase extends AgentTurnBase {
  /** Idempotency key scoped to this agent. Reusing it with a different spec rejects. */
  id: TurnId;
}

export interface AgentTextTurnSpec extends EnqueuedTurnBase {
  schema?: undefined;
}

export interface AgentStructuredTurnSpec<T extends JsonValue> extends EnqueuedTurnBase {
  schema: OutputSchema<T>;
}

interface AgentRunBase extends AgentTurnBase {
  /** Idempotency key scoped to this agent. Generated when omitted. */
  id?: TurnId;
  /** On `unanswered`, invokes `TurnRef.nudge` before later queued turns. */
  nudge?: true | NudgeOptions;
}

export interface AgentRunTextSpec extends AgentRunBase {
  schema?: undefined;
}

export interface AgentRunStructuredSpec<T extends JsonValue> extends AgentRunBase {
  schema: OutputSchema<T>;
}

export type TurnCost = {
  /** Non-negative amount in `currency`. */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  basis: "charged" | "list" | "estimated";
};

/** Non-negative integer token counts. */
export type TokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type TurnUsage = {
  /** Nested workflow call ids from outermost to innermost; empty at the root. */
  callPath: string[];
  agent: AgentKey;
  operationId: string;
  /** Resolved execution for this operation. */
  execution: UsageExecution;
  /** Totals across every attempt made for this operation. */
  tokens?: TokenUsage;
  /** Total across attempts. Absent means unavailable; zero is a known zero. */
  cost?: TurnCost;
};

export type TurnOutcome<T extends JsonValue> = (
  | { kind: "answered"; value: T }
  | { kind: "unanswered"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string; retryable: boolean }
  | { kind: "cancelled"; reason: string }
) & { usage: TurnUsage };

export type RunResult<T extends JsonValue> = {
  /** The nudge outcome when one ran; otherwise the initial outcome. */
  outcome: TurnOutcome<T>;
  /** Usage for the initial operation and its nudge, when one ran. */
  usage: TurnUsage[];
};

export interface TurnRef<T extends JsonValue> {
  readonly id: TurnId;
  /** Resolves to an explicit terminal state; an absent agent answer is never successful data. */
  readonly result: Promise<TurnOutcome<T>>;
  /**
   * Continues an unanswered turn as a separately accounted operation with a derived id. Repeating
   * the same nudge returns the same ref; a different nudge or later queued operation rejects.
   */
  nudge(options?: NudgeOptions): Promise<TurnRef<T>>;
  /** Returns false when cancellation is unsupported or the turn is already terminal. */
  cancel(reason?: string): Promise<boolean>;
}

export interface CompactSpec {
  id: CompactionId;
  prompt: string;
}

export interface AgentRef extends ParticipantRef {
  readonly key: AgentKey;
  /** Fixed for this logical agent, including replacement after a crash. */
  readonly execution: AgentExecution;
  /** Resolves once durably queued. Turns execute one at a time in enqueue order. */
  enqueue(spec: AgentTextTurnSpec): Promise<TurnRef<string>>;
  enqueue<T extends JsonValue>(spec: AgentStructuredTurnSpec<T>): Promise<TurnRef<T>>;
  /**
   * Runs and awaits. Supplied ids cover the complete spec; conflicting reuse rejects. Cancellation
   * by another ref or workflow shutdown resolves as `cancelled`.
   */
  run(spec: AgentRunTextSpec): Promise<RunResult<string>>;
  run<T extends JsonValue>(spec: AgentRunStructuredSpec<T>): Promise<RunResult<T>>;
  /**
   * Runs after earlier operations and is idempotent by compaction id. An answer is the summary
   * retained as context; any other outcome leaves the prior context available.
   */
  compact(spec: CompactSpec): Promise<TurnOutcome<string>>;
}

export interface AgentDirectory {
  /**
   * Reattaches by logical key when every supplied field matches; omitted optional fields do not
   * constrain an existing agent. Runtime requirements are never silently relaxed. A conflicting
   * spec or occupied outside-participant key rejects rather than mutating the existing participant.
   */
  open(spec: AgentOpenSpec): Promise<AgentRef>;
  /** Returns null when absent; rejects when an existing agent conflicts with the requirements. */
  attach(key: AgentKey, runtime?: RuntimeSelection): Promise<AgentRef | null>;
  /** Returns false when the logical agent does not exist or is already stopped. */
  stop(key: AgentKey, reason?: string): Promise<boolean>;
}
