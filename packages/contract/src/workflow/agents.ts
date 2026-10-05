import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { ParticipantRef } from "./participants";
import type { InlineSandboxSpec, SandboxRef } from "./sandboxes";
import type { AbsoluteDeadline } from "./timing";

export type AgentKey = string;
/**
 * Where a skill comes from, as a record keeps it; its name is the one its `SKILL.md` gives. A skill
 * is code its harness runs, so every agent gets a copy of its own, never the source.
 */
export type SkillSource =
  /** A directory holding a `SKILL.md`, by its absolute path. */
  | { path: string }
  /**
   * A public skill, as skills.sh names one: `repo` is `owner/repo` on GitHub or a git URL, `skill`
   * the name in its `SKILL.md`, at `ref` or, absent, the default branch when the run starts.
   */
  | { repo: string; skill: string; ref?: string };

/**
 * A source as a workflow names it: a path may also be a `file:` URL. One beside the workflow is
 * `new URL("./skills/name", import.meta.url)`, which stays right when another workflow calls it; a
 * relative path is refused, as it would not.
 */
export type SkillRef = SkillSource | { path: URL };
export type RuntimeAliasName = string;
export type TurnId = string;
export type CompactionId = string;
export type HarnessKind = string;
export type SettingsId = string;
/** A harness's own level name, such as claude's `max` or codex's `xhigh`; see its definition's `effort`. */
export type Effort = string;

/** What an alias names: today a harness, a model and an effort; later perhaps a pool or sandbox. */
export type RuntimeTarget = {
  harness: HarnessKind;
  model: string;
  /** Absent, awf passes none and the harness uses its default. */
  effort?: Effort;
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
  /**
   * Replaces the alias's effort rather than having to match it, unlike `model`: `set` could change
   * it straight after the agent opens anyway. Given on a reopen, it must match the effort the agent
   * was opened at; left out, it does not constrain, as `model` does not.
   */
  effort?: Effort;
};

/** An alias, constrained alias, or complete execution configuration. */
export type RuntimeSelection = RuntimeAliasName | ExecutionRequirements | ExecutionConfig;

export type AgentExecution = ExecutionConfig & {
  /**
   * Present when this execution was selected through an alias: the one it was opened through, whose
   * model a `set` may since have changed.
   */
  alias?: RuntimeAliasName;
  /**
   * The session the run was started from with `awf run --here`, which the run found rather than
   * opened (ADR 0010). Its `model` is `""`: the operator chose it, and spend records carry it.
   */
  caller?: true;
};

export interface AgentOpenSpec {
  /** Logical identity scoped to the current workflow run. */
  key: AgentKey;
  /** Bounds this operation; defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Defaults to the workflow's working directory. */
  cwd?: string;
  instructions?: string;
  /** Selects the harness and model. */
  runtime: RuntimeSelection;
  /**
   * Exactly the skills this agent has, beside what its harness will not give up: claude's bundled
   * skills, and claude's and codex's working directory's own; pi keeps nothing else. Absent, it has
   * what it would have without awf: the operator's on the host, none in a sandbox.
   */
  skills?: readonly SkillRef[];
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
  /** Fixed before queueing; defaults to the current scope and covers all automatic check-ins. */
  deadline?: AbsoluteDeadline;
  /** Relative bound from invocation, capped by the current scope; waiting never extends it. */
  timeoutMs?: number;
  label?: string;
  /**
   * Enables automatic recovery, with repeated check-ins where delivery is confirmed.
   * `false` disables it. A supplied deadline can shorten the operation, never extend it.
   */
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
  /** ISO time the operation settled, after any automatic check-ins; its deadline when it expired. */
  settledAt?: string;
  /** Every native session seen for this agent by the time this record was made. */
  sessions: NativeSessionRef[];
  /** The workflow stage it ran in; absent between stages. */
  stage?: string;
  /** The turn's own label, as the workflow gave it. */
  label?: string;
};

export type TurnOutcome<T extends JsonValue> = (
  | { kind: "answered"; value: T }
  | { kind: "unanswered"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "timed-out"; reason: string }
  | { kind: "failed"; reason: string; retryable: boolean }
  | { kind: "cancelled"; reason: string }
) & {
  /** Times and sessions across every delivery attempt made to settle this operation. */
  usage: OperationRecord;
};

export function isAnswered<T extends JsonValue>(
  outcome: TurnOutcome<T>,
): outcome is Extract<TurnOutcome<T>, { kind: "answered" }> {
  return outcome.kind === "answered";
}

export type RunResult<T extends JsonValue> = {
  /** The whole operation outcome, including automatic check-ins and bounded native release. */
  outcome: TurnOutcome<T>;
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
  /** Idempotency key scoped to this agent. Generated when omitted. */
  id?: CompactionId;
  /** What the harness's own compaction keeps and drops, as an operator types after `/compact`. */
  prompt: string;
  /** Bounds this operation; defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Relative bound from invocation, capped by the current workflow scope deadline. */
  timeoutMs?: number;
}

export interface AgentForkSpec extends PlacementChoice {
  /** The new agent's key in this run. */
  key: AgentKey;
  /** Given with its first turn; it already knows what this agent was told. */
  instructions?: string;
  labels?: JsonObject;
  /** Absent, the fork takes its parent's effort when it is taken, as it takes its model. */
  effort?: Effort;
}

export interface SettingsSpec {
  /** Idempotency key scoped to this agent. Generated when omitted. */
  id?: SettingsId;
  /** Another model of the same harness. */
  model?: string;
  effort?: Effort;
  /** Bounds this operation; defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Relative bound from invocation, capped by the current workflow scope deadline. */
  timeoutMs?: number;
}

export interface AgentRef extends ParticipantRef {
  readonly key: AgentKey;
  /**
   * The agent's settings now: as it was opened, then as the last answered `set` left them. Its
   * harness, placement and alias never change.
   */
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
   * Runs the harness's own compaction after earlier operations, idempotent by compaction id. An
   * answer means it compacted, and is its summary where the harness exposes one, else `""`; any
   * other outcome leaves the prior context available.
   */
  compact(spec: CompactSpec): Promise<TurnOutcome<string>>;
  /**
   * Switches this session's model or effort for every operation after the earlier ones, idempotent
   * by id; its context is kept. Answered once the switch is in force, with the settings then in
   * force as the outcome's `usage.execution`. Refused before it runs where the harness can't switch,
   * with why, and for an effort the harness doesn't list. One that fails or times out in a pane
   * closes the agent, whose settings nobody then knows.
   */
  set(spec: SettingsSpec): Promise<TurnOutcome<null>>;
  /**
   * Opens a new agent on a copy of this agent's session, taken after its earlier operations: it
   * starts knowing what this agent knew then, and from then on neither sees the other's turns. It
   * has this agent's harness, model, working directory, sandbox and skills, and this agent's
   * placement and effort unless it names its own; model and effort are those after every `set`
   * queued before it. Rejects before this agent's first turn, where the harness cannot fork, and
   * where a `set` queued before it did not take. The same key with the same parent and spec returns the same agent (ADR 0009).
   */
  fork(spec: AgentForkSpec): Promise<AgentRef>;
}

export interface CallerSpec {
  /** The key the calling session goes by in this run, as any agent's does. */
  key: AgentKey;
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
  /**
   * The session `awf run --here` was started from, as an agent under `spec.key`; `null` when the
   * run has none (ADR 0010). The same key returns the same ref and another key rejects. It is the
   * operator's session, so it differs from an opened agent: `compact` fails; a turn that fails, is
   * cancelled or times out leaves it usable rather than closed; the operator interrupting a turn
   * settles it `cancelled`; where the harness's interrupt cannot be recognised, an unanswered turn
   * is not nudged by default; and its `execution.model` is `""`.
   */
  caller(spec: CallerSpec): Promise<AgentRef | null>;
}
