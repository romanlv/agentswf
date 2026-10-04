import type {
  AbsoluteDeadline,
  AgentExecution,
  AgentKey,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  CompactionId,
  Effort,
  HarnessKind,
  JsonObject,
  JsonValue,
  NudgeOptions,
  OutputSchema,
  RuntimeAliases,
  TurnId,
} from "@agentswf/contract/workflow";
import type { Occupant } from "@agentswf/sandbox";
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

/**
 * The turn as the workflow wrote it, beside the prompt the engine wraps for delivery. A production
 * adapter delivers the wrapped prompt and never reads this; a host that answers as the agent, as a
 * workflow's test does, reads it instead of parsing the wrapped prompt apart.
 */
export interface HarnessAuthored {
  authored?: AuthoredTurn;
}

/** A turn as the workflow wrote it. A nudge has its own prompt and its turn's label and schema. */
export type AuthoredTurn = {
  prompt: string;
  label?: string;
  schema?: OutputSchema<JsonValue>;
};

/** `prompt` is the wrapped prompt the agent is sent. */
export interface HarnessNudgeSpec extends NudgeOptions, HarnessAuthored {
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
  /**
   * Set only on a compaction the harness confirmed: its summary as the harness wrote it, or `""`
   * where it keeps it opaque, as codex does.
   */
  summary?: string;
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
   * The operation's result is in, or nothing waits on it any more without ending the session, as
   * for a compaction past its deadline. A host whose next operation resumes this session may answer
   * `finishing` instead of stopping the turn; one that ignores this stops it, which is safe.
   */
  answered?: boolean;
};

export interface HarnessSession {
  status(): Promise<HarnessSessionStatus>;
  /** `turn.prompt` is the wrapped prompt the agent is sent. */
  start(
    turn: AgentTextTurnSpec & HarnessAuthored,
    binding: HarnessOperationBinding,
  ): Promise<HarnessTurn>;
  start<T extends JsonValue>(
    turn: AgentStructuredTurnSpec<T> & HarnessAuthored,
    binding: HarnessOperationBinding,
  ): Promise<HarnessTurn>;
  compact(id: CompactionId, prompt: string, deadline: AbsoluteDeadline): Promise<HarnessTurn>;
  /**
   * Switches the session's model and effort for every later turn, its context kept, once any turn
   * left finishing has ended; resolves once they are in force. Absent where the host cannot switch
   * this agent; see `settingsRefusal`. A pane whose switch rejects is in settings nobody knows; a
   * headless switch applies whole or not at all.
   */
  set?(settings: SessionSettings, deadline: AbsoluteDeadline): Promise<void>;
  /**
   * A copy of this session, taken by the harness's own fork with no model call, once any turn left
   * finishing has ended (ADR 0009). Absent where the host cannot fork; rejects before the agent's
   * own first turn and where its harness cannot.
   */
  fork?(deadline: AbsoluteDeadline, into?: SessionCopy): Promise<NativeFork>;
  close(reason?: string): Promise<void>;
  /** Every native session id the adapter has seen for this agent, in the order first seen. */
  sessions?(): readonly string[];
  /**
   * When the host first prompted the agent, for a host that waits on the agent after a turn starts:
   * the calling session's, which may still be the operator's own turn until then (ADR 0010).
   */
  promptedAt?(): number | undefined;
}

/** The settings a session runs at, whole: an absent effort is the harness's default. */
export type SessionSettings = { model: string; effort?: Effort };

/**
 * Where a fork's session is carried when the new agent's harness home is not its parent's: the
 * parent's session files are copied into `directory`, by their paths in its home, for the engine
 * to place in the new one before it is admitted.
 */
export type SessionCopy = { directory: string };

/**
 * A session the harness forked, for a new agent to continue. The engine hands it from the parent's
 * `fork` to the child's activation and never reads it: everything native about a fork stays here.
 */
export type NativeFork = {
  readonly harness: HarnessKind;
  readonly sessionRef: string;
  /** The running total the harness printed at the fork, where it prints one: the parent's. */
  readonly costTotal?: number;
  /**
   * The parent's session was copied, not forked: into a home not its own, which the new agent's
   * harness forks it in when it is activated, through its own place.
   */
  readonly copied?: true;
};

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
  /**
   * The forked session this agent continues instead of starting one. An adapter that cannot
   * continue one, or one forked by another harness, refuses the agent.
   */
  continues?: NativeFork;
  /**
   * The harness home it runs with, where its sessions are: a sandbox's, or one of its own on the
   * host. Absent, the operator's.
   */
  home?: string;
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
  /**
   * The session `awf run --here` was started from, when this host drives one (ADR 0010). An agent
   * whose execution says `caller` is that session, and a run whose host has none has no caller.
   */
  readonly caller?: { harness: HarnessKind; cwd: string };
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
