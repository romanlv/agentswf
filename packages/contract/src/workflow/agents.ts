import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { ParticipantRef } from "./participants";
import type { InlineSandboxSpec, SandboxRef } from "./sandboxes";
import type { AbsoluteDeadline } from "./timing";

export type AgentKey = string;
export type SkillName = string;
export type RuntimeAliasName = string;
export type TurnId = string;
export type CompactionId = string;
export type HarnessKind = string;

/** What an alias names: today a harness and model; later perhaps a pool or sandbox. */
export type RuntimeTarget = {
  harness: HarnessKind;
  model: string;
};

/**
 * Where an agent runs: a terminal pane it keeps between turns, or a headless process per turn.
 * Both answer through the same result channel, under the same deadlines and cleanup.
 */
export type AgentPlacement = "pane" | "headless";

export type PlacementChoice = {
  /** Defaults to `pane`. */
  placement?: AgentPlacement;
  /**
   * The author's consent to per-token billing, needed to run headless a harness that bills that
   * way even on a subscription login, as `claude -p` does (E3). The run host refuses such an agent
   * without it. It says nothing about how an agent was billed: see `Billing`. It is dropped from a
   * pane agent, where it means nothing.
   */
  metered?: true;
};

export function placementOf(choice: PlacementChoice): AgentPlacement {
  return choice.placement ?? "pane";
}

export type ExecutionConfig = RuntimeTarget & PlacementChoice;

/** A centrally configured name for a runtime target. Placement is the agent's choice. */
export type RuntimeAliases = Readonly<Record<RuntimeAliasName, RuntimeTarget>>;

export type ExecutionRequirements = PlacementChoice & {
  /**
   * Fields the alias names (`harness`, `model`) are constraints: when supplied they must match
   * it. Fields the agent owns (`placement`, `metered`) are added to it. Reopening an agent, they
   * are constraints too: left out, the agent stays as it was opened.
   */
  alias: RuntimeAliasName;
  harness?: HarnessKind;
  model?: string;
};

/** An alias, constrained alias, or complete execution configuration. */
export type RuntimeSelection = RuntimeAliasName | ExecutionRequirements | ExecutionConfig;

export type AgentExecution = ExecutionConfig & {
  /** Present when this execution was selected through an alias. */
  alias?: RuntimeAliasName;
};

export interface AgentOpenSpec {
  /** Logical identity scoped to the current workflow run. */
  key: AgentKey;
  /** Defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Defaults to the workflow's working directory. */
  cwd?: string;
  instructions?: string;
  /** Selects the harness and model. */
  runtime: RuntimeSelection;
  /** Harness-neutral skill names made available to this logical agent. */
  skills?: readonly SkillName[];
  labels?: JsonObject;
  /**
   * The sandbox this agent runs in: one this run opened, shared with its other agents, or a spec
   * for a private one. Absent, the agent runs unsandboxed.
   */
  sandbox?: SandboxRef | InlineSandboxSpec;
}

interface AgentTurnBase {
  prompt: string;
  /** Bounds this turn, including waiting for an accepted result. */
  deadline: AbsoluteDeadline;
  label?: string;
}

export interface NudgeOptions {
  /** Bounds presentation and settlement of the continuation. */
  deadline: AbsoluteDeadline;
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

interface AgentRunBase {
  /** Idempotency key scoped to this agent. Generated when omitted. */
  id?: TurnId;
  prompt: string;
  /** Defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Relative bound, capped by the current workflow scope deadline. */
  timeoutMs?: number;
  label?: string;
  /** On `unanswered`, runs standard recovery by default; `false` disables it. */
  nudge?: false | (Omit<NudgeOptions, "deadline"> & { deadline?: AbsoluteDeadline });
}

export interface AgentRunTextSpec extends AgentRunBase {
  schema?: undefined;
}

export interface AgentRunStructuredSpec<T extends JsonValue> extends AgentRunBase {
  schema: OutputSchema<T>;
}

/** A harness's own session, as it names it: an id, or for some harnesses a file path. */
export type NativeSessionRef = { harness: HarnessKind; id: string };

/**
 * An operation's usage while the run goes on: its times and sessions. What it spent is read once
 * the run has ended, into a `SettledOperation` record.
 */
export type OperationRecord = {
  /** Nested workflow call ids from outermost to innermost; empty at the root. */
  callPath: string[];
  agent: AgentKey;
  operationId: string;
  /** Resolved execution for this operation. */
  execution: AgentExecution;
  /** ISO time the harness accepted the first attempt; absent when none was made. */
  deliveredAt?: string;
  /** ISO time the operation settled, after any nudge; its deadline when it expired. */
  settledAt?: string;
  /** Every native session seen for this agent by the time this record was made. */
  sessions: NativeSessionRef[];
};

export type TurnOutcome<T extends JsonValue> = (
  | { kind: "answered"; value: T }
  | { kind: "unanswered"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "timed-out"; reason: string }
  | { kind: "failed"; reason: string; retryable: boolean }
  | { kind: "cancelled"; reason: string }
) & { usage: OperationRecord };

export function isAnswered<T extends JsonValue>(
  outcome: TurnOutcome<T>,
): outcome is Extract<TurnOutcome<T>, { kind: "answered" }> {
  return outcome.kind === "answered";
}

export type RunResult<T extends JsonValue> = {
  /** The nudge outcome when one ran; otherwise the initial outcome. */
  outcome: TurnOutcome<T>;
  /** Times and sessions across every delivery attempt made to settle this operation. */
  usage: OperationRecord;
};

export interface TurnRef<T extends JsonValue> {
  readonly id: TurnId;
  /** Resolves to an explicit terminal state; an absent agent answer is never successful data. */
  readonly result: Promise<TurnOutcome<T>>;
  /**
   * Makes one additional delivery attempt against this turn's existing result slot and authority.
   * Repeating the same nudge returns the same ref; a different nudge or later queued operation
   * rejects.
   */
  nudge(options: NudgeOptions): Promise<TurnRef<T>>;
  /** Returns false when cancellation is unsupported or the turn is already terminal. */
  cancel(reason?: string): Promise<boolean>;
}

export interface CompactSpec {
  id: CompactionId;
  prompt: string;
  deadline: AbsoluteDeadline;
}

export interface AgentRef extends ParticipantRef {
  readonly key: AgentKey;
  /** Fixed for this logical agent. */
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
