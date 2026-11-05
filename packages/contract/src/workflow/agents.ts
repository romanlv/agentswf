import { reportDeprecated } from "./deprecated";
import type { AgentEnded, AgentEndOf } from "./events";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { PeerRef } from "./participants";
import type { InlineSandboxSpec, SandboxRef } from "./sandboxes";
import type { AbsoluteDeadline } from "./timing";
import type { Duration, EventLike, Source, Taken, Timeout } from "./waits";

/**
 * An agent's key in its run: a name, as events and stages are (lowercase letters, digits, `.`,
 * `_`, `@` and `-`, starting with a letter or digit), since it names its operations' folders,
 * `ops/{key}.{n}/`. Agents and decisions share the names. A colon is still accepted, deprecated.
 */
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
 * How an agent runs: its harness's own TUI, kept between turns in a terminal awf opens for it, or a
 * headless process per turn. Both answer through the same result channel, under the same deadlines
 * and cleanup.
 */
export type AgentPlacement = "tui" | "headless";

export type PlacementChoice = {
  /** Defaults to `tui`. */
  placement?: AgentPlacement;
  /**
   * The author's consent to per-token billing, needed to run headless a harness that bills that
   * way even on a subscription login, as `claude -p` does (E3). The run host refuses such an agent
   * without it. It says nothing about how an agent was billed: see `Billing`. It is dropped from a
   * TUI agent, where it means nothing.
   */
  metered?: true;
};

export function placementOf(choice: PlacementChoice): AgentPlacement {
  return choice.placement ?? "tui";
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
  /** Bounds opening it, within the stage, `parallel` and run around it. */
  timeout?: Timeout;
  /** @deprecated Give `timeout`: a `Date`, or a `Duration` such as `"10m"`. */
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
  /** @deprecated Drop it: nothing reads an agent's labels. */
  labels?: JsonObject;
  /**
   * The sandbox this agent runs in: one this run opened, shared with its other agents, or a spec
   * for a private one. Absent, the agent runs unsandboxed.
   */
  sandbox?: SandboxRef | InlineSandboxSpec;
  /**
   * Where its pane goes among the run's, and whether it is the one the operator should see;
   * absent, a tab of its own. Which workspace, and whether panes stay, are the operator's:
   * `awf run --workspace` and `--keep-panes`. TUI agents only.
   */
  pane?: PaneSpec;
  /**
   * @deprecated Give `pane: { tab }` or `pane: { beside, side }`; the workspace is the operator's,
   * `awf run --workspace`, and the session `AWF_HERDR_SESSION`.
   */
  layout?: PaneLayout;
  /** @deprecated Keeping panes is the operator's: `awf run --keep-panes`. */
  keepPane?: KeepPane;
  /**
   * What the agent can ask the workflow's code to do mid-turn, by name: holding a tool is what lets
   * it call one. Taught in every operation's prompt. On a reopen, tools match by name, description
   * and input schema, never by handler: matching ones take the new handlers and budgets, and left
   * out, the agent keeps what it has.
   */
  tools?: AgentTools;
  /**
   * In a run of a workflow with `events`, keeps the run live, rather than parked, for a window
   * after each turn this agent runs: awaited, started, or a message's. A message in the window is a
   * turn in the same pane, its end a new window. The run parks once no agent's window is open and
   * no `onTimeout` is due. A turn that fails or times out closes the agent, and a closed agent holds
   * no window. On a reopen it takes the new spec; left out, the agent keeps what it has. A run
   * without events never parks, and refuses it.
   */
  keepAlive?: {
    /** How long the run stays live after this agent's last turn ends; absent, an hour. */
    window?: Duration;
    /** @deprecated Give `window`, a `Duration` such as `"90s"`. */
    timeoutMs?: number;
    /**
     * Called once the window passes, if a turn ended since it last ran, at a wait with nothing to
     * take and nothing working, which awaits it in its own scope: to compact the agent while its
     * cache is warm, say. No turn it begins opens a window, on any agent; a message it has a peer
     * send is the peer's turn. It must settle: the wait takes no event until it does. A throw is
     * logged; the run parks anyway.
     */
    onTimeout?: (agent: AgentRef) => Promise<void> | void;
  };
}

/** An agent's tools by name, each name matching `TOOL_LIMITS.name`. */
export type AgentTools = Readonly<Record<string, ToolSpec>>;

/**
 * A tool the workflow's code runs for an agent, which calls it with `wfa tool {name}` while it is in a
 * turn and waits for the result. Write one with `tool()`, which types the handler's input from
 * `input`.
 */
export interface ToolSpec<I extends JsonObject = JsonObject> {
  /** What it is for, as the agent reads it in its prompt. */
  description: string;
  /**
   * An object schema, carrying its type as `run()`'s `schema` does, so a TypeBox schema is wrapped
   * in `typed(...)` from `agentswf/typebox`. Absent, the tool takes no input, and its handler
   * is given `{}`.
   */
  input?: OutputSchema<I>;
  /**
   * Runs once per accepted call, in the scope of the operation the call came in, and must be short.
   * What it returns is the result the agent reads: a string as is, any other JSON value as JSON,
   * nothing as nothing. A throw fails the call, not the run. It may not run, stop or fork an agent
   * whose handler it is in, nor `wf.receive()`.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: an async handler that returns nothing is a Promise<void>.
  handler(input: I, call: ToolCall): Promise<JsonValue | void> | JsonValue | void;
  /**
   * Each call's budget, within the operation's deadline; absent, `TOOL_LIMITS.defaultTimeoutMs`;
   * `false`, only the deadline. A shell command past its harness's own limit is moved to the
   * background, or on codex handed back for the agent to poll, past 10 s by default (M2).
   */
  timeout?: Duration | false;
  /** @deprecated Give `timeout`, a `Duration` such as `"30s"`, or `false`. */
  timeoutMs?: number | false;
}

/** One call of a tool, as its handler is given it. */
export type ToolCall = {
  /** Unique within the run, across attempts; a turn run again after a crash calls with new ids. */
  readonly id: string;
  /** The agent that called: a fork's own key, not its parent's. */
  readonly agent: AgentKey;
  /** Aborted when the call's budget passes or its operation is cancelled, stopped or ends. */
  readonly signal: AbortSignal;
};

/**
 * A tool, its handler's input typed from its `input` schema, or `{}` without one. Written inline
 * instead, a handler's input is a `JsonObject`, and an annotation on it goes unchecked.
 */
export function tool(spec: ToolSpec<NoInput> & { input?: undefined }): ToolSpec<NoInput>;
export function tool<I extends JsonObject>(
  spec: ToolSpec<I> & { input: OutputSchema<I> },
): ToolSpec<I>;
export function tool(spec: ToolSpec): ToolSpec {
  return spec;
}

/** What a tool that takes no input is given. */
export type NoInput = Record<string, never>;

/** Refused at `open` and `fork` past these, so the lesson in every prompt stays bounded. */
export const TOOL_LIMITS = {
  /** Room for the `mcp__{server}__` prefix an MCP client adds. */
  name: /^[a-z][a-z0-9_]{0,47}$/,
  tools: 16,
  descriptionBytes: 1024,
  /** In the schema's canonical form, `canonicalSchema`. */
  schemaBytes: 8192,
  defaultTimeoutMs: 30_000,
  /** A call's input, and its result encoded as JSON. */
  inputBytes: 65_536,
  resultBytes: 65_536,
} as const;

/**
 * Where a TUI agent's pane is placed, once, as it opens, or in a run of a workflow with `events` at
 * its first turn: a new tab, or beside the pane of an agent already open, which it splits. Where it
 * can't be used, the agent gets a tab of its own instead, and the run says why; it never fails the
 * agent. Which workspace a new tab opens in is the operator's, `awf run --workspace`. See
 * `docs/design/pane-layout.md`.
 */
export type PaneSpec =
  | {
      /** The new tab's label; absent, the agent's key. Every `tab` is a new tab. */
      tab?: string;
      /**
       * The pane the operator should see: its tab is brought to the front as it is placed, in the
       * operator's own workspace (`awf run --workspace origin`) only.
       */
      front?: boolean;
      beside?: never;
      side?: never;
      share?: never;
    }
  | {
      /** Another agent of this run, whose pane this one splits. */
      beside: AgentKey;
      /** The side of that pane the new one goes on. */
      side: "right" | "below";
      /** The new pane's part of the space it splits, 0.2 to 0.8; absent, 0.5. */
      share?: number;
      /**
       * The pane the operator should see: its tab is brought to the front as it is placed, in the
       * operator's own workspace (`awf run --workspace origin`) only.
       */
      front?: boolean;
      tab?: never;
    };

/**
 * A pane's place as the deprecated `layout` gives it, and as the engine asks a harness for it: the
 * workflow's `pane`, in the workspace the operator's `--workspace` or the layout names.
 */
export type PaneLayout =
  | {
      /** The terminal session; absent, the run's. One awf does not start is used only if running. */
      session?: string;
      /** Where the new tab opens in it; absent, `"run"`. */
      workspace?: PaneWorkspace;
      /** The new tab's label; absent, the agent's key. Every `tab` is a new tab. */
      tab?: string;
      beside?: never;
      side?: never;
      share?: never;
    }
  | {
      /** Another agent of this run, whose pane this one splits. */
      beside: AgentKey;
      /** The side of that pane the new one goes on. */
      side: "right" | "below";
      /** The new pane's part of the space it splits, 0.2 to 0.8; absent, 0.5. */
      share?: number;
      session?: never;
      workspace?: never;
      tab?: never;
    };

/**
 * The run's own workspace, the one `awf run` was typed in, or the one with this label, found or
 * made.
 */
export type PaneWorkspace = "run" | "origin" | { name: string };

/**
 * Whether a pane stays once its agent is done, as `awf run --keep-panes` gives it; `on-failure`,
 * when its last operation was not answered. A kept pane keeps its harness running, released from
 * the run: its result channel is closed, and it is the operator's from then on.
 */
export type KeepPane = "never" | "on-failure" | "always";

interface AgentTurnBase {
  prompt: string;
  /** Bounds this turn, including waiting for an accepted result. */
  deadline: AbsoluteDeadline;
  label?: string;
}

/** A turn as a harness is handed it: its id and deadline fixed. */
interface HarnessTurnBase extends AgentTurnBase {
  /** Idempotency key scoped to this agent. Reusing it with a different spec rejects. */
  id: TurnId;
}

export interface AgentTextTurnSpec extends HarnessTurnBase {
  schema?: undefined;
}

export interface AgentStructuredTurnSpec<T extends JsonValue> extends HarnessTurnBase {
  schema: OutputSchema<T>;
}

export interface NudgeOptions {
  /** Bounds presentation and settlement of the continuation. */
  deadline: AbsoluteDeadline;
  /** Uses the engine's standard missing-answer recovery prompt when omitted. */
  prompt?: string;
}

interface AgentRunBase {
  /**
   * Idempotency key scoped to this agent within one attempt: `run()` with an id it already ran
   * returns that turn's result, and `start()` refuses it. Generated when omitted.
   *
   * @deprecated Drop it: a later attempt doesn't know it, and a stage keeps a call from running twice.
   */
  id?: TurnId;
  prompt: string;
  /**
   * Bounds the turn and its automatic check-ins, fixed when it is called, within the stage,
   * `parallel` and run around it. A wait for an outside participant's answer moves it out by the
   * wait's length, within those.
   */
  timeout?: Timeout;
  /** @deprecated Give `timeout`: a `Date`, or a `Duration` such as `"10m"`. */
  deadline?: AbsoluteDeadline;
  /** @deprecated Give `timeout`, a `Duration` such as `"10m"`. */
  timeoutMs?: number;
  label?: string;
  /** Enables automatic recovery, with repeated check-ins where delivery is confirmed. `false` disables it. */
  nudge?:
    | false
    | (Omit<NudgeOptions, "deadline"> & {
        /** @deprecated Drop it: `timeout` bounds the turn and its check-ins. */
        deadline?: AbsoluteDeadline;
      });
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
  /** Why it ran: absent for the workflow's own operations. */
  cause?: OperationCause;
};

/**
 * Why an operation ran that the workflow did not start: a message from `from`, woken through a
 * route, which needs no result.
 */
export type OperationCause = { message: { from: AgentKey } };

/** A harness that needs the operator to log in again. */
export type TurnLogin = {
  harness: string;
  /** The provider whose login it is, where the harness logs in to several, as pi does. */
  provider?: string;
  /** What the operator runs, in words to show, not parse: "run `pi`, then /login". */
  run: string;
};

/**
 * How an operation settled. `answered` is the check a workflow makes: true only with a `value`,
 * which may itself be falsy (`""`, `0`, `null`); `kind` says which way it went otherwise.
 */
export type TurnOutcome<T extends JsonValue> = (
  | { answered: true; kind: "answered"; value: T }
  | { answered: false; kind: "unanswered"; reason: string }
  | { answered: false; kind: "blocked"; reason: string }
  | { answered: false; kind: "timed-out"; reason: string }
  | {
      answered: false;
      kind: "failed";
      reason: string;
      retryable: boolean;
      /**
       * Set when the agent's harness has no login, or its login was refused: every agent on it
       * fails the same way until the operator logs in, so a workflow may stop here.
       */
      login?: TurnLogin;
    }
  | { answered: false; kind: "cancelled"; reason: string }
) & {
  /** Times and sessions across every delivery attempt made to settle this operation. */
  usage: OperationRecord;
};

/** @deprecated Check `outcome.answered`, which narrows the same way. */
export function isAnswered<T extends JsonValue>(
  outcome: TurnOutcome<T>,
): outcome is Extract<TurnOutcome<T>, { kind: "answered" }> {
  reportDeprecated(outcome, "isAnswered");
  return outcome.kind === "answered";
}

export type RunResult<T extends JsonValue> = {
  /** The whole operation outcome, including automatic check-ins and bounded native release. */
  outcome: TurnOutcome<T>;
};

/** `run()`'s spec, and what the turn's end carries back in `agent:ended`, `null` when absent. */
export type AgentStartSpec = (AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>) & {
  meta?: JsonValue;
};

/**
 * A turn `start()` began, until a wait takes its end. Its result comes as `agent:ended`, which a
 * wait takes by naming the agent. A turn given to a wait as its source is deprecated: name the
 * agent, `{ done: agent }`, which has at most one started turn.
 */
export interface StartedTurn extends Source<Taken<AgentEnded>> {
  readonly id: TurnId;
  /** @deprecated Use `agent.is(e)`: an agent has at most one started turn. */
  is<
    Meta extends JsonValue = JsonValue,
    T extends JsonValue = JsonValue,
    E extends EventLike = EventLike,
  >(event: E): event is E & AgentEndOf<E, Meta, T>;
  /**
   * Stops the turn; resolves once its `cancelled` end is recorded, or at once, `false`, when
   * it had ended already.
   */
  cancel(reason?: string): Promise<boolean>;
}

export interface CompactSpec {
  /**
   * Idempotency key scoped to this agent. Generated when omitted.
   *
   * @deprecated Drop it: a later attempt doesn't know it, and a stage keeps a call from running twice.
   */
  id?: CompactionId;
  /** What the harness's own compaction keeps and drops, as an operator types after `/compact`. */
  prompt: string;
  /** Bounds this operation, within the stage, `parallel` and run around it. */
  timeout?: Timeout;
  /** @deprecated Give `timeout`: a `Date`, or a `Duration` such as `"10m"`. */
  deadline?: AbsoluteDeadline;
  /** @deprecated Give `timeout`, a `Duration` such as `"10m"`. */
  timeoutMs?: number;
}

/**
 * How a fork runs: always on its parent's harness and model, since it continues its parent's
 * session, in the placement and at the effort it names, else its parent's.
 */
export type ForkRuntime = PlacementChoice & {
  /** Absent, the fork takes its parent's effort when it is taken, as it takes its model. */
  effort?: Effort;
};

/** What a fork of the calling session is given, and what every fork may be. */
export interface CallerForkSpec {
  /** The new agent's key in this run. */
  key: AgentKey;
  /** Bounds taking the copy and opening it, within the stage, `parallel` and run around it. */
  timeout?: Timeout;
  /** Given with its first turn; it already knows what this agent was told. */
  instructions?: string;
  /** @deprecated Drop it: nothing reads an agent's labels. */
  labels?: JsonObject;
  /** Absent, its parent's placement and effort. Refused beside any of the flat fields below. */
  runtime?: ForkRuntime;
  /** @deprecated Give it in `runtime`: `runtime: { placement }`. */
  placement?: AgentPlacement;
  /** @deprecated Give it in `runtime`: `runtime: { metered: true }`. */
  metered?: true;
  /** @deprecated Give it in `runtime`: `runtime: { effort }`. */
  effort?: Effort;
  /** Never its parent's: absent, a tab of its own. */
  pane?: PaneSpec;
  /**
   * @deprecated Give `pane: { tab }` or `pane: { beside, side }`; the workspace is the operator's,
   * `awf run --workspace`, and the session `AWF_HERDR_SESSION`.
   */
  layout?: PaneLayout;
  /** @deprecated Keeping panes is the operator's: `awf run --keep-panes`. */
  keepPane?: KeepPane;
}

export interface AgentForkSpec extends CallerForkSpec {
  /**
   * Replaces the parent's tools; `{}` gives none. Absent, it has the parent's, with the handlers
   * they had when it forked. A fork of the calling session takes none.
   */
  tools?: AgentTools;
}

export interface SettingsSpec {
  /**
   * Idempotency key scoped to this agent. Generated when omitted.
   *
   * @deprecated Drop it: a later attempt doesn't know it, and a stage keeps a call from running twice.
   */
  id?: SettingsId;
  /** Another model of the same harness. */
  model?: string;
  effort?: Effort;
  /** Bounds this operation, within the stage, `parallel` and run around it. */
  timeout?: Timeout;
  /** @deprecated Give `timeout`: a `Date`, or a `Duration` such as `"10m"`. */
  deadline?: AbsoluteDeadline;
  /** @deprecated Give `timeout`, a `Duration` such as `"10m"`. */
  timeoutMs?: number;
}

/**
 * What every agent of the run can do, the calling session included, which can do only this: its
 * session is the operator's, so it is neither compacted nor switched, and its fork takes no tools.
 * Every `AgentRef` is one. As a source, a wait takes the end of the turn `start()` began.
 */
export interface CallerRef extends PeerRef, Source<Taken<AgentEnded>> {
  readonly key: AgentKey;
  /**
   * The agent's settings now: as it was opened, then as the last answered `set` left them. Its
   * harness, placement and alias never change.
   */
  readonly execution: AgentExecution;
  /**
   * Runs and awaits. Supplied ids cover the complete spec; conflicting reuse rejects. Cancellation
   * by another ref or workflow shutdown resolves as `cancelled`.
   */
  run(spec: AgentRunTextSpec): Promise<RunResult<string>>;
  run<T extends JsonValue>(spec: AgentRunStructuredSpec<T>): Promise<RunResult<T>>;
  /**
   * Opens a new agent on a copy of this agent's session, taken after its earlier operations: it
   * starts knowing what this agent knew then, and from then on neither sees the other's turns. It
   * has this agent's harness, model, working directory, sandbox and skills, and this agent's
   * placement and effort unless its `runtime` names its own; model and effort are those after every
   * `set` queued before it. Rejects before this agent's first turn, where the harness cannot fork,
   * and where a `set` queued before it did not take. The same key with the same parent and spec
   * returns the same agent (ADR 0009). The calling session's is `forkCaller`'s fork.
   */
  fork(spec: CallerForkSpec): Promise<AgentRef>;
  /**
   * The turn `start()` began, from then until a wait takes its end, restored on a continue for a
   * turn whose end no wait took; `null` otherwise. While it is set, the agent refuses `start()`,
   * `run()`, `compact()`, `set()`, `fork()` and messages from other agents.
   */
  readonly turn: StartedTurn | null;
  /**
   * Begins the turn `run()` would, and returns once it is recorded and launched. Its end arrives at
   * the run's wait as `agent:ended` from this agent's key, with the outcome, checked against
   * `schema` as `run()`'s is, and `meta`. At the run's root scope only, and in a run of a workflow
   * with `events`: its end arrives as an event, so a run without them refuses it.
   */
  start(spec: AgentStartSpec): Promise<StartedTurn>;
  /**
   * True for this agent's end, `{key}:ended` or `agent:ended`, narrowing its data to the `meta` the code started the
   * turn with and the outcome its `schema` gives.
   */
  is<
    Meta extends JsonValue = JsonValue,
    T extends JsonValue = JsonValue,
    E extends EventLike = EventLike,
  >(event: E): event is E & AgentEndOf<E, Meta, T>;
  /**
   * Ends the agent before the run does: a turn it is running is cancelled, and its pane closed or,
   * where `keepPane` says, kept and released (ADR 0008); the calling session is handed back to the
   * operator. Its key is not opened again. Resolves false once an earlier `close()` or
   * `wf.agents.stop` has ended it, and true otherwise, for an agent a failed turn closed too.
   */
  close(reason?: string): Promise<boolean>;
}

/** An agent the run opened or forked. */
export interface AgentRef extends CallerRef {
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
  /** As `CallerRef.fork`, and its fork may be given tools of its own. */
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
   * spec or occupied outside-participant key rejects rather than mutating the existing agent;
   * so does a reserved key, `operator`, `awf`, `system` or `user`.
   */
  open(spec: AgentOpenSpec): Promise<AgentRef>;
  /**
   * As `close()` on the agent's ref, and false too when the agent was never opened or did not open.
   *
   * @deprecated Call `close(reason?)` on the agent's ref.
   */
  stop(key: AgentKey, reason?: string): Promise<boolean>;
  /**
   * The session `awf run --here` was started from, as an agent under `spec.key`; `null` when the
   * run has none (ADR 0010). The same key returns the same ref and another key rejects. It is the
   * operator's session, so it differs from an opened agent: it has no `compact` or `set`; a turn
   * that fails, is cancelled or times out leaves it usable rather than closed; the operator
   * interrupting a turn settles it `cancelled`; where the harness's interrupt cannot be recognised,
   * an unanswered turn is not nudged by default; `close()` hands it back to the operator; and its
   * `execution.model` is `""`. Its `fork` is `forkCaller`'s.
   */
  caller(spec: CallerSpec): Promise<CallerRef | null>;
  /**
   * A new agent on a copy of the session `awf run` was started from: one waiting on the command,
   * or handed over with `--here`, whose copy is then taken after the run's turns to it. `null` when
   * the run has none to fork; the run's output says why. The fork runs on the model the session's
   * files show it last ran, in its directory, as an agent of the run; what it copied stays the
   * session's spend. Root scope only (story 027).
   */
  forkCaller(spec: CallerForkSpec): Promise<AgentRef | null>;
}

/** @deprecated Use `AgentRef`: every agent is one. */
export type EventAgentRef = AgentRef;

/** @deprecated Use `AgentOpenSpec`, which holds `keepAlive`. */
export type EventAgentOpenSpec = AgentOpenSpec;

/** @deprecated Use `AgentDirectory`: every workflow's agents are one. */
export type EventAgentDirectory = AgentDirectory;
