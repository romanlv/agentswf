import type { JsonSchema } from "./schema";
import type { HolderCode, InboxCode, ReplyCode, SendCode } from "./wire";
import type {
  AgentExecution,
  AgentKey,
  HarnessKind,
  KeepPane,
  NativeSessionRef,
  OperationRecord,
  PaneLayout,
  PaneWorkspace,
  SkillSource,
  TurnId,
  TurnOutcome,
} from "./workflow/agents";
import type { DecisionRecord, Question } from "./workflow/decisions";
import type { EmitOutcome, EventId } from "./workflow/events";
import type { AttemptOutcome, StageSummary, UnfinishedOutcome } from "./workflow/executable";
import type { JsonObject, JsonValue } from "./workflow/json";
import type {
  Domain,
  Gitdir,
  SandboxEnvironmentKey,
  SandboxKey,
  SandboxSpec,
} from "./workflow/sandboxes";
import type { StageOutcome } from "./workflow/workflow";

/** What the run directory records about one call. The format only; the engine does the I/O. */
export type CallSpec = {
  callId: string;
  question: string;
  schema?: JsonSchema;
};

/**
 * Which channel carried a candidate value — `control-plane` in production. A string, because
 * candidates recorded by the archived experiments name channels of their own.
 */
export type CandidateSource = string;

/** Every candidate value, accepted or not. A rejection is evidence, so it is never dropped. */
export type Candidate = {
  at: string;
  source: CandidateSource;
  accepted: boolean;
  raw: string;
  error?: string;
};

export type Money = {
  /** Non-negative amount in `currency`. */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
};

/** Non-negative integer token counts, in classes that are priced differently. */
export type TokenUsage = {
  /** Uncached input only. */
  input: number;
  cacheRead: number;
  /** Every cache write, whatever its lifetime. */
  cacheWrite: number;
  /** The part of `cacheWrite` with a one-hour lifetime, where the harness reports it. */
  cacheWrite1h?: number;
  /** Includes reasoning. */
  output: number;
  /** The part of `output` spent reasoning, where the harness reports it. */
  reasoning?: number;
};

/** One model's tokens; `delegated` marks what the agent's own subagents spent. */
export type ModelSpend = { model: string; delegated: boolean; tokens: TokenUsage };

/** Who paid for an agent: a plan, or per token. `unknown` only when that could not be told. */
export type Billing = "subscription" | "metered" | "unknown";

/**
 * An operation's record once the run has ended and its agent's spend was read. It records no
 * price, so a finished run can be priced again with another table. Records are deliberately
 * self-contained: an agent's sessions and billing repeat on each of its operations, so a flat list
 * can be summarised and re-priced alone.
 */
export type SettledOperation = OperationRecord & {
  billing: Billing;
  /** Absent means unknown. */
  spend?: ModelSpend[];
  /** Only what was actually billed per token; decided with `billing`. */
  charged?: Money;
};

/**
 * What `decisions/{n}.json` in a run's artifacts holds: everything asked and answered, so a
 * threshold can be fitted again without calling the model.
 */
export type DecisionArtifact = {
  record: SettledDecision;
  request: { state: string | JsonObject | JsonValue[]; questions: Record<string, Question> };
  /** As `decide` returned them; absent when the call did not answer. */
  answers?: JsonObject;
};

/** A decision once the run has ended: what the provider said it charged, beside its record. */
export type SettledDecision = DecisionRecord & {
  /** As the provider reported it; absent when it reported none. */
  charged?: Money;
};

/**
 * What a slice's decisions cost. Kept apart from the agent figures, which count agents: a decision
 * model with no rate folded into those would lower `estimate` with no gap showing.
 */
export type DecisionFigures = {
  calls: number;
  /** Requests sent, retries included. */
  attempts: number;
  tokens: { input: number; output: number };
  /** USD at list price, over the calls whose tokens are known and priced. */
  estimate?: number;
  /** USD the provider reported charging. */
  charged?: number;
  /** How many of `calls` have known tokens. */
  known: number;
  /** How many of `calls` were known and priced. */
  priced: number;
};

/** One slice of a run: all of it, a stage, or one agent. */
export type AccountingFigures = {
  agents: number;
  /** The sum, over operations, of the time from delivery to settle. */
  agentMs: number;
  tokens: TokenUsage;
  /** The part of `tokens` the agents' own subagents spent. */
  delegated: TokenUsage;
  /**
   * USD at list price, over the priced tokens. Absent only when no agent's usage was both known
   * and priced: a known zero is 0, an unknown is never one.
   */
  estimate?: number;
  /** USD actually billed per token. */
  charged?: number;
  /** How many of `agents` have known usage. */
  known: number;
  /** How many of `agents` had all their usage priced. */
  priced: number;
  /**
   * How many of `agents` have a known billing and every charge counted in `charged`; the rest may
   * have been charged unseen.
   */
  billed: number;
  /** Absent when the slice asked no decision model anything. */
  decisions?: DecisionFigures;
};

/** One model's share. Time and charges belong to an operation, not a model, so are not split. */
export type ModelFigures = {
  model: string;
  agents: number;
  /** Decision calls whose tokens are known, as this model; absent when there are none. */
  decisionCalls?: number;
  tokens: TokenUsage;
  delegated: TokenUsage;
  /** Absent when the table has no rate for the model; see `unpriced`. */
  estimate?: number;
};

/** What a run cost and how long it took, derived from its settled operations and its two times. */
export type RunAccounting = {
  /** The price table `estimate` came from. */
  basis: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  /**
   * What `byStage` groups by: the workflow's stages, or, for a run without any, the call path and
   * key prefix.
   */
  grouping: "stages" | "prefix";
  /** `mixed` when agents whose billing is known disagree; `unknown` when none is known. */
  billing: Billing | "mixed";
  totals: AccountingFigures;
  /**
   * Each workflow stage entered, in order, a reused one at zero, then `(no stage)` for what ran
   * between stages. A run without stages groups by the call path and the agent or decision key's
   * prefix before `:`, joined with `/`.
   */
  byStage: (AccountingFigures & { stage: string; spanMs: number })[];
  byModel: ModelFigures[];
  byAgent: (Omit<AccountingFigures, "decisions"> & {
    callPath: string[];
    agent: string;
    execution: AgentExecution;
    billing: Billing;
  })[];
  /** Models, agents' or decisions', the table has no rate for. Their tokens are counted; their cost is not. */
  unpriced: string[];
};

/** A sandbox a run opened, with every agent it admitted. */
export type SandboxRecord = {
  callPath: string[];
  /** `agent:{key}` for a private sandbox, a namespace explicit keys cannot use. */
  key: SandboxKey;
  /** An environment key such as `srt` or `docker`; more come with new providers, so a reader never switches on it exhaustively. */
  provider: SandboxEnvironmentKey;
  /** Absolute paths: `~` expanded and `.` resolved. */
  spec: SandboxSpec & { cwd: string };
  /** The engine-minted directory holding its homes. */
  directory: string;
  /** The git directories its paths belong to, reachable beyond `spec`. */
  gitdirs: Gitdir[];
  /** Every domain reachable in the end: `network` plus the admitted harnesses' model domains. */
  domains: Domain[];
  /**
   * What only its provider knew about how it ran, in the provider's own shape, as `spec` holds its
   * settings under its key: docker's `image`, the digest the box ran; srt's `toolchain`, the host
   * paths it re-allowed beyond reach.
   */
  provided?: JsonObject;
  /** Every agent admitted, including one whose turns never completed. */
  agents: { callPath: string[]; agent: string; home: string }[];
};

/** Where a pane agent's pane was placed, and why not where its layout said, for the record. */
export type PanePlacement = {
  /** The terminal session it is in. */
  session: string;
  workspace: PaneWorkspace;
  /** The new tab's label; absent for a pane beside another. */
  tab?: string;
  /** The agent whose pane it split. */
  beside?: string;
  /** Why its layout was not used, where it wasn't. */
  fallback?: string;
  /** Left open when the agent was done, its harness running. */
  kept?: true;
  /** Why a pane asked to be kept was closed instead. */
  notKept?: string;
};

/** Where a pane agent's pane went: its layout as the workflow wrote it, and where it was placed. */
export type AgentPaneRecord = {
  callPath: string[];
  agent: string;
  layout?: PaneLayout;
  keepPane?: KeepPane;
  placed: PanePlacement;
};

/** One skill an agent was given, as it was copied to it. */
export type SkillRecord = {
  /** The name in its `SKILL.md`, and the directory it was copied to. */
  name: string;
  /** As the workflow named it, a URL made a path. */
  source: SkillSource;
  /** The commit a `repo` source resolved to. */
  commit?: string;
  /** Where in the repository it was found. */
  within?: string;
  /** `sha256:` over the copied tree: each file's path, whether it is executable, and its bytes. */
  digest: string;
};

/** The skills an agent was given. */
export type AgentSkillsRecord = {
  callPath: string[];
  agent: string;
  /**
   * `operator` for an agent on the host the workflow named none for, which had the operator's. One
   * in a sandbox had none of them: `[]`.
   */
  skills: "operator" | SkillRecord[];
  /** The harness home of its own it ran with on the host, when its harness needs one for skills. */
  home?: string;
};

export const RUN_RECORD_VERSION = 1 as const;

/**
 * `run.json`: what a run is, written once as its folder is claimed. A run's status, current stage
 * and last attempt are read off its other files, so none of them is here to go stale.
 */
export type RunRecord = {
  version: typeof RUN_RECORD_VERSION;
  /** Unique within its workflow; its folder's name. */
  id: string;
  /** The workflow's `meta.name`, never its file. */
  workflow: string;
  /** As given, not as parsed: a continue prepares it again with the code as it is then. */
  argv: string[];
  /** Where every attempt works. */
  cwd: string;
  /** `awf run --sandbox`'s spec, as its file gave it, which every attempt runs in. */
  sandbox: JsonValue | null;
  created: string;
  /**
   * A run of a workflow with `events`: what its `key` made of the event that started it. Its `cwd`
   * is its project, and its `argv` empty.
   */
  key?: string;
  /** With `key`: the `PATH` it was first started with, which every attempt runs with. */
  env?: { PATH: string };
};

export const ATTEMPT_RECORD_VERSION = 1 as const;

/**
 * `attempts/{attempt}.json`: one `awf run` of a run. Written whole when the attempt claims its number, and
 * again when it ends, with its ending.
 */
export type AttemptRecord = {
  version: typeof ATTEMPT_RECORD_VERSION;
  attempt: number;
  /**
   * The file it ran; never identity. A run of a workflow with `events` is continued from its last
   * attempt's, unless what wakes it names its target, whose file the next attempt records.
   */
  file: string;
  /** The workflow's `meta.version`, when it gives one. */
  workflowVersion?: string;
  /** `timeout` absent: the attempt had no deadline. */
  flags: { timeout?: string; fromStage?: string };
  /** With `processStart`, what makes the attempt checkably live: a pid alone may be reused. */
  pid: number;
  /** As `ps -o lstart=` gives it, as an ISO time to the second. */
  processStart: string;
  started: string;
  ended?: string;
  outcome?: AttemptOutcome;
  /** The stage the attempt ended in; absent when it ended between stages. */
  stage?: string;
  /** Why it did not complete. */
  reason?: string;
  /** Each stage it entered that ran or was reused, in order. */
  stages?: AttemptStage[];
  /**
   * What it cost, as far as a run's total needs: `output.json` holds the last attempt's in full,
   * and turns carry no spend, so an earlier attempt's is kept here. Absent for an interrupted one.
   */
  accounting?: AttemptAccounting;
  /** The messaging ceilings in force; absent on attempts an earlier awf ran. */
  messageLimits?: MessageLimits;
  /**
   * A completed run of a workflow with `events`: how many events in its mailbox were never
   * acknowledged, taken or not. Its key refuses every later event.
   */
  unacknowledged?: number;
};

/** What an attempt's file keeps of its accounting: what a run's total sums. */
export type AttemptAccounting = Pick<
  RunAccounting,
  "basis" | "wallMs" | "grouping" | "billing" | "totals" | "byStage" | "unpriced"
>;

/** A stage an attempt entered, as its files record it: no value, which `stages/` holds. */
export type AttemptStage = Omit<StageSummary, "value">;

export const MAILBOX_RECORD_VERSION = 1 as const;

/**
 * A line of `mailbox.jsonl`, the run's events and what its waits did with them, appended under the
 * key's lock by whoever writes it: a sender, the run, or awf on the run's behalf.
 */
export type MailboxRecord = {
  version: typeof MAILBOX_RECORD_VERSION;
  /** An ISO time. */
  at: string;
} & (
  | {
      kind: "event";
      id: EventId;
      name: string;
      data: JsonValue;
      /** As `WorkflowEvent.from`. */
      from: string;
    }
  /**
   * A wait called: it acknowledges what the last `took` returned, unless a stage recorded that
   * batch. `until` is an ISO time.
   */
  | { kind: "wait"; attempt: number; label?: string; until?: string }
  /**
   * The wait returning these events, in order; none when its `until` passed. `stage`: it was in
   * that stage, which holds the batch, acknowledged, and returns it again on a rerun.
   */
  | { kind: "took"; attempt: number; ids: EventId[]; stage?: string }
  /**
   * A turn `start()` began, written before its agent is launched; the rest of it is in
   * `turns.jsonl`. Its end is the event `agent:ended`, with id `awf.end.{hash}`, the hash of the
   * agent's key and the turn's id, so one end is ever kept.
   */
  | { kind: "turn"; attempt: number; agent: AgentKey; turn: TurnId; meta: JsonValue }
);

export const STAGE_RECORD_VERSION = 1 as const;

/**
 * `stages/{stage}.json`: the run's current record of a stage, written whole when the stage ends,
 * by the attempt that ran it.
 */
export type StageRecord = {
  version: typeof STAGE_RECORD_VERSION;
  stage: string;
  /** The attempt that ran it. */
  attempt: number;
  outcome: StageOutcome;
  /** Why it did not succeed. */
  reason?: string;
  started: string;
  ended: string;
  workflowVersion?: string;
  /** The agents' native sessions its turns used. */
  sessions: { agent: AgentKey; harness: HarnessKind; session: string }[];
  /** The stage's own one line, from its `summary`. */
  summary?: string;
  /** As returned, after a JSON round trip; absent for a stage that returns nothing. */
  value?: JsonValue;
  /**
   * Its value was given to start the run at a later stage, `awf run --values`, or it returns
   * nothing and was passed: no turn ran it. Reused as a succeeded stage is.
   */
  provided?: true;
};

/** A stage a run can't start at a later stage without: its value, which `--values` gives. */
export type StageNeed = { stage: string; schema: JsonSchema };

export const TURN_RECORD_VERSION = 1 as const;

/** What a line of `turns.jsonl` keeps of its operation's record. */
export const TURN_OPERATION_FIELDS = [
  "agent",
  "operationId",
  "execution",
  "stage",
  "label",
  "deliveredAt",
  "settledAt",
  "sessions",
  "cause",
] as const satisfies readonly (keyof OperationRecord)[];

/**
 * A line of `turns.jsonl`: a turn, nudges included, or a compaction, as it settled, with the attempt
 * it was in. Its `sessions` are its agent's as of then: the last is the one it ran on. What it spent
 * is read from its sessions once the attempt ends, so a line has none.
 */
export type TurnRecord = {
  version: typeof TURN_RECORD_VERSION;
  attempt: number;
  kind: "turn" | "compact";
  outcome: TurnOutcome<JsonValue>["kind"];
  /** Absent on lines an earlier awf wrote. */
  callPath?: string[];
} & Pick<OperationRecord, (typeof TURN_OPERATION_FIELDS)[number]>;

/** An operation's fields on its start or failure: a turn line's, but its settling. */
type OperationEvent = { of: TurnRecord["kind"]; callPath: string[] } & Pick<
  OperationRecord,
  Exclude<(typeof TURN_OPERATION_FIELDS)[number], "settledAt">
>;

/**
 * Every line of the run's event log but a settled turn's. Keyed, never given an id: a span's start
 * and end carry the same keys (attempt, stage, `operationId`, decision), and the tree is read off
 * them. Observation only: `--continue` never reads it (ADR 0011).
 */
export type RunEvent = {
  /** Its kind's, from `RUN_EVENT_VERSIONS`. */
  version: number;
  attempt: number;
  at: string;
} & (
  | { kind: "attempt-started" }
  | { kind: "attempt-ended"; outcome: AttemptOutcome }
  | { kind: "stage-started"; stage: string }
  /** A stage not run in this attempt, its value reused or given, writes only its end. */
  | { kind: "stage-ended"; stage: string; outcome: StageOutcome; source?: "reused" | "provided" }
  /** Written at delivery; its `sessions` name the native session when it is known by then. */
  | ({ kind: "operation-started" } & OperationEvent)
  /** May have no start: an operation can fail before it is delivered. */
  | ({ kind: "operation-failed"; error: string } & OperationEvent)
  | {
      kind: "session-known";
      session: NativeSessionRef;
      /** A headless turn whose harness named its session while it ran. */
      operationId?: string;
      /** A fork, once its session exists. */
      agent?: AgentKey;
    }
  | {
      kind: "agent-opened";
      agent: AgentKey;
      callPath: string[];
      harness: HarnessKind;
      /** Where it runs, a sandbox's when in one: its native files are found by it. */
      cwd: string;
      /** A sandboxed agent's own harness home; absent for the operator's. */
      home?: string;
      /** The calling session (ADR 0010). */
      caller?: true;
    }
  | { kind: "agent-stopped"; agent: AgentKey; callPath: string[]; harness: HarnessKind }
  | {
      kind: "agent-forked";
      agent: AgentKey;
      /** The agent it was copied from; null for a calling session the run never opened. */
      from: AgentKey | null;
      /** The parent's operation it was copied after; null when the parent ran nothing in this run. */
      after: string | null;
    }
  | { kind: "log" | "warning"; text: string; fields?: JsonObject; stage?: string }
  /** `decision` numbers it in the order asked within the attempt. */
  | ({ kind: "decision-asked"; decision: number } & Pick<
      DecisionRecord,
      "stage" | "key" | "alias" | "provider" | "model"
    >)
  | ({ kind: "decision-ended"; decision: number } & Pick<
      DecisionRecord,
      "stage" | "outcome" | "error"
    >)
  | MessagingEvent
);

/**
 * A route's ends, as the workflow granted it: `between` is one route both ways, with one count, its
 * two ends in the order given, which means nothing. A pair has one open route at a time, so its ends
 * name it. An end is an agent's key or an outside participant's.
 */
export type RouteEnds =
  | { from: AgentKey; to: AgentKey; between?: never }
  | { between: [AgentKey, AgentKey]; from?: never; to?: never };

/**
 * Why a message admitted was never shown: its sender stopped waiting before its peer saw it, its
 * route closed, or the attempt ended.
 */
export type UndeliveredReason = "withdrawn" | "route-closed" | "attempt-ended";

/**
 * How an owed answer ended: answered with `wf reply` or `awf reply`; failed (its peer stopped,
 * failed, or still owed it after its reminder); the asker's `--timeout` or its route's passed; the
 * asker finished first, before its peer saw the question (`withdrawn`) or after (`released`), or
 * the outside participant it was owed by was released (`released`); a deadline the workflow set
 * around the asker passed, or its scope was cancelled (`cancelled`); or the attempt ended.
 */
export type RequestEnd =
  | "replied"
  | "failed"
  | "timed-out"
  | "withdrawn"
  | "released"
  | "cancelled"
  | "attempt-ended";

/** What an outside participant's message came through: `awf run`'s prompt, `awf reply` or `awf send`, a test's script. */
export type OutsideVia = "terminal" | "command" | "test";

/**
 * Messaging in the run's event log, keyed by attempt and `message`, numbered in the order admitted
 * within the attempt. Written by the side that saw each: the engine on admission and its end, the
 * delivery with what the harness confirmed.
 */
export type MessagingEvent =
  /** An outside participant connected, with the labels the workflow gave it. */
  | {
      kind: "participant-connected";
      callPath: string[];
      participant: string;
      labels?: JsonObject;
    }
  | ({
      kind: "route-opened";
      callPath: string[];
      purpose: string;
      /** The limit in force, answers included, and what the workflow asked for when it differed. */
      maxMessages: number;
      asked?: number;
      /** A route to an outside participant: how long a question on it waits. */
      timeoutMs?: number;
      /** The stage it closes with; absent, it lasts the attempt. */
      stage?: string;
    } & RouteEnds)
  | ({
      kind: "route-closed";
      callPath: string[];
      reason: "stage-ended" | "agent-stopped" | "released" | "attempt-ended";
    } & RouteEnds)
  /**
   * Admitted, before `wf send`, `wf reply`, `awf send` or `awf reply` returned. `operationId` is the
   * sender's open operation; an outside participant has none, and says what it came through
   * instead. A question carries the answer's deadline, if it has one; an answer, the question it
   * answers.
   */
  | ({
      kind: "message-sent";
      callPath: string[];
      message: number;
      from: AgentKey;
      to: AgentKey;
      text: string;
      bytes: number;
      /** It awaits an answer, by this time when it has a limit. */
      awaitsReply?: { until?: string };
      /** The question it answers. */
      replyTo?: number;
    } & ({ operationId: string; via?: never } | { via: OutsideVia; operationId?: never }))
  /** Refused before admission, with the code `wf` printed. */
  | {
      kind: "message-refused";
      callPath: string[];
      from: AgentKey;
      to: AgentKey;
      /** Absent for `no-operation`. */
      operationId?: string;
      command: "send" | "reply";
      code: SendCode | ReplyCode;
      bytes: number;
      awaitReply?: true;
    }
  /**
   * Shown to its recipient in `operationId`: `offered` once typed or its resumed turn started, then
   * `observed` where the harness confirmed the model read it, else `unconfirmed`.
   */
  | {
      kind: "message-delivery";
      callPath: string[];
      message: number;
      from: AgentKey;
      to: AgentKey;
      operationId: string;
      state: "offered" | "observed" | "unconfirmed";
    }
  | {
      kind: "message-undelivered";
      callPath: string[];
      message: number;
      from: AgentKey;
      to: AgentKey;
      reason: UndeliveredReason;
    }
  /** An owed answer's end. `message` is the question; `reply`, its answer's number. */
  | {
      kind: "request-ended";
      callPath: string[];
      message: number;
      /** The agent that owed it, and the asker. */
      owedBy: AgentKey;
      asker: AgentKey;
      end: RequestEnd;
      reason?: string;
      reply?: number;
    };

/** The messaging ceilings an attempt ran under. A route's `maxMessages` may only lower `perRoute`. */
export type MessageLimits = {
  /** Messages a route carries an attempt, answers included. */
  perRoute: number;
  /** A message's size in UTF-8 bytes. */
  bytes: number;
  /** Messages admitted for one agent and not yet shown to it. */
  unread: number;
  /** A message operation's own time, before its waiters' deadlines lengthen it. */
  operationMs: number;
};

/**
 * What an agent did, read from its native session files when asked and never copied into the run.
 * A message is its length only, and a tool its name and a short argument, cut and with common
 * credential shapes masked: the native files hold the rest.
 */
export type Activity =
  | { type: "message"; from: "agent" | "user"; chars: number }
  | {
      type: "tool";
      tool: string;
      input?: string;
      /** Pairs it with its result. */
      call?: string;
      /** It goes on running after the call returns. */
      background?: true;
    }
  /** `exit` only where the harness logs one as data: codex's shell calls; claude logs none. */
  | { type: "tool-result"; call?: string; error?: true; exit?: number }
  /** A task started in the background said it ended: claude's task notification. */
  | { type: "background-ended" }
  | { type: "compaction" };

/** A line of `turns.jsonl`, the run's event log. */
export type RunLogLine = TurnRecord | RunEvent;

/**
 * What `awf runs --json` and `awf logs --json` print: one document per call. A reader ignores the
 * kinds and fields it does not know; `v` changes only when one is renamed or removed. Times are ISO.
 */
/**
 * `stuck`: a run of a workflow with `events` that failed or crashed three attempts in a row; its
 * events are kept, and only `awf run --continue` goes on.
 */
export type RunStateJson = "running" | "interrupted" | "stuck" | AttemptOutcome;

/** A run of a workflow with `events` at its wait, live or parked: the wait's label and `until`. */
export type WaitingJson = { label?: string; until?: string };

/** A run as both commands head it. `checked: false`: a `running` whose process was not asked. */
export type RunHeadJson = {
  ref: string;
  state: RunStateJson;
  checked: boolean;
  stage?: string;
  /** Once the run has ended. */
  duration?: number;
  waiting?: WaitingJson;
};

/** `awf runs --json`. */
export type RunsJson = {
  v: 1;
  runs: (
    | {
        ref: string;
        state: RunStateJson;
        checked: boolean;
        started: string;
        duration?: number;
        estimate?: number;
        waiting?: WaitingJson;
      }
    | { ref: string; unreadable: string }
  )[];
  more: { older: boolean };
};

/** `awf runs {ref} --json`: durable fields, and best effort under each agent's `live`. */
export type RunJson = {
  v: 1;
  run: RunHeadJson & { estimate?: number; dir: string };
  attempts: {
    attempt: number;
    started: string;
    ended?: string;
    state: RunStateJson;
    stage?: string;
    reason?: string;
  }[];
  stages: { stage: string; state: string; started?: string; ended?: string }[];
  agents: {
    key: AgentKey;
    harness?: HarnessKind;
    caller?: true;
    stage?: string;
    state: string;
    turns: number;
    sessions: { harness: HarnessKind; id: string; files: string[] }[];
    live: {
      /** `waiting` after `wf waiting`; `awaiting-reply` on `peer`'s answer. */
      phase?: "waiting" | "awaiting-reply";
      reason?: string;
      peer?: AgentKey;
      until?: string;
      lastActivity?: { activity: Activity; at: string };
      observedAt: string;
    };
  }[];
  decisions: { decision: number; key: string; asked: string; outcome?: string }[];
  cursor: string;
  /** While it runs. */
  next?: string[];
  /** Where it can go on. */
  continue?: string;
};

/** An event as `awf logs --json` publishes it, with the keys that place it. */
export type LogEventJson = { handle: string; at: string } & (
  | {
      kind: "activity";
      /** `null` between the agent's operations. */
      operation: string | null;
      agent?: AgentKey;
      stage?: string;
      activity: Activity;
      /** The native text: the message, the tool's whole argument, or its output. */
      text?: string;
    }
  | (DistributiveOmit<RunLogLine, "version"> & { operation?: string })
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * `awf logs --json`. In a page, a string the run wrote is cut at 50,000 characters; a read of one
 * `@handle` gives it whole, and has no `cursor`, `more` or `next`: it pages nothing.
 */
export type LogsJson = {
  v: 1;
  run: RunHeadJson & { ambiguous?: boolean };
  events: LogEventJson[];
  cursor?: string;
  more?: { older?: true; newer?: true };
  /** While the run goes on, or while the page stopped before the newest event. */
  next?: string[];
};

/**
 * Why a question to a coordinator closed unanswered, as `awf inbox` reports it, from its
 * `request-ended`: `timed-out` is `timeout`, and the others keep their names. Such a question is
 * shown when recorded, so never `withdrawn`; an outside participant is never reminded and never
 * stops, so never `failed`.
 */
export type InboxExpiry = "timeout" | "released" | "cancelled" | "attempt-ended";

/**
 * One line of `awf inbox --json`, oldest first. Agents are peer addresses, qualified in a child
 * call; message ids are `{attempt}.{n}`. A reader ignores the kinds and fields it does not know;
 * `v` changes only when one is renamed or removed.
 */
export type InboxItemJson = {
  v: 1;
  /** `{workflow}/{id}`. */
  run: string;
  at: string;
  /** `--after` this reads on from just after the item; absent under `--open`, a snapshot. */
  cursor?: string;
} & (
  | {
      kind: "route";
      state: "opened" | "closed";
      coordinator: string;
      agent: string;
      /** Which way it carries messages: `both` for `between`, else from or to the coordinator. */
      direction: "both" | "to-coordinator" | "from-coordinator";
      purpose: string;
      /** How long a question on it waits; absent, until it is answered. */
      timeoutMs?: number;
      /** The coordinator's, as the workflow connected it. */
      labels?: JsonObject;
      /** Why it closed. */
      reason?: "stage-ended" | "agent-stopped" | "released" | "attempt-ended";
    }
  | {
      kind: "message";
      coordinator: string;
      id: string;
      /** One is the coordinator's key, the other an agent's address. */
      from: string;
      to: string;
      text: string;
      /** A question to the coordinator, open until an `answered` or `expired` item says otherwise. */
      asks?: true;
      /** When the question closes unanswered, if it has a limit. */
      until?: string;
      /** From the coordinator, an `awf send` or a script's: what it came through. Its answers are `answered` items. */
      via?: OutsideVia;
    }
  | { kind: "answered"; coordinator: string; id: string; answer: string; via: OutsideVia }
  /** `participant.post(text)` to a participant routed to the code, under `coordinator`, its key. */
  | { kind: "post"; coordinator: string; id: string; text: string }
  | { kind: "expired"; coordinator: string; id: string; reason: InboxExpiry }
  | { kind: "ended"; attempt: number; outcome: AttemptOutcome | "interrupted" }
);

/**
 * `awf reply --json` and `awf send --json`. `delivered`'s `id` is what an `awf inbox` item names:
 * for a reply, the question answered, as its `answered` item has it; for a send, the new message.
 */
export type HolderResultJson =
  | { v: 1; code: "delivered"; id: string }
  | {
      v: 1;
      code: HolderCode;
      /** The refusal as the command prints it, naming what to do instead. */
      error: string;
      /** For `ambiguous`: the coordinator keys, agent addresses or question ids to choose from. */
      choices?: string[];
    };

/** What `wake` did to a run: started, nudged or continued it, or nothing. */
export type WakeDid = "started" | "nudged" | "continued" | "none";

/**
 * Why an event was refused, or `wake` did nothing: the run returned; no run, and the event doesn't
 * start one; stuck, stopped or cancelled, which need the operator; parked with nothing due; a live
 * run's nudge that failed, whose wait takes the event anyway.
 */
export type WakeWhy =
  | "returned"
  | "not-a-start"
  | "stuck"
  | "stopped"
  | "cancelled"
  | "nothing-due"
  | "nudge-failed";

/** `awf emit --json`, and `awf send --json` to a participant routed to the code. */
export type EmitResultJson = {
  v: 1;
  outcome: EmitOutcome;
  /** `{workflow}/{id}`. */
  run: string;
  /** The event's id, as given or as awf made it. */
  id: string;
  did: WakeDid;
  why?: WakeWhy;
};

/** `awf tick --json`: each run it woke, in the order woken. */
export type TickResultJson = {
  v: 1;
  woke: {
    run: string;
    did: "continued";
    why: "event" | "until" | "crashed" | "failed";
  }[];
};

/** `awf inbox --json` when it read nothing. */
export type InboxErrorJson = { v: 1; code: InboxCode; error: string };

/** Each kind's own version, which changes when that kind's shape does. */
export const RUN_EVENT_VERSIONS = {
  "attempt-started": 1,
  "attempt-ended": 1,
  "stage-started": 1,
  "stage-ended": 1,
  "operation-started": 1,
  "operation-failed": 1,
  "session-known": 1,
  "agent-opened": 1,
  "agent-stopped": 1,
  "agent-forked": 1,
  log: 1,
  warning: 1,
  "decision-asked": 1,
  "decision-ended": 1,
  "route-opened": 1,
  "route-closed": 2,
  "message-sent": 2,
  "message-refused": 1,
  "message-delivery": 1,
  "message-undelivered": 1,
  "request-ended": 2,
  "participant-connected": 1,
} as const satisfies Record<RunEvent["kind"], number>;

/** A kind whose older lines are a strict subset of its current shape, read as the current one. */
const RUN_EVENT_OLDEST_READ: Partial<Record<RunEvent["kind"], number>> = {
  "route-closed": 1,
  "message-sent": 1,
  "request-ended": 1,
};

/**
 * The line as this reader knows it, or undefined for a kind or version it does not know, which
 * every reader skips so that a later awf can add kinds.
 */
export function runLogLine(value: object): RunLogLine | undefined {
  const { kind, version, attempt } = value as Record<string, unknown>;
  if (typeof attempt !== "number") return undefined;
  // The first turn lines, written for a day before turns had a kind, were all turns.
  if (kind === "turn" || kind === "compact" || kind === undefined) {
    return version === TURN_RECORD_VERSION ? ({ kind: "turn", ...value } as TurnRecord) : undefined;
  }
  if (typeof kind !== "string") return undefined;
  if (!Object.hasOwn(RUN_EVENT_VERSIONS, kind) || typeof version !== "number") return undefined;
  const current = RUN_EVENT_VERSIONS[kind as RunEvent["kind"]];
  const oldest = RUN_EVENT_OLDEST_READ[kind as RunEvent["kind"]] ?? current;
  return version >= oldest && version <= current ? (value as RunEvent) : undefined;
}

export const OUTPUT_RECORD_VERSION = 5 as const;

/**
 * An attempt, as the operator CLI keeps it in `output.json` and prints it with `--json`, in the
 * words of its attempt file. One that didn't complete keeps what it spent too; only a completed one
 * has a value.
 */
export type OutputRecord = {
  version: typeof OUTPUT_RECORD_VERSION;
  /** The run's id, the same in every attempt. */
  runId: string;
  /** The attempt that wrote this record: `output.json` is the last ended attempt's. */
  attempt: number;
  workflow: { name: string; file: string };
  accounting: RunAccounting;
  usage: SettledOperation[];
  /** The run's folder. */
  artifacts: string;
  /**
   * Each sandbox the run opened, once. Absent when it opened none. Readers must not switch
   * exhaustively over a sandbox's `provider`.
   */
  sandboxes?: SandboxRecord[];
  /** Each agent's skills, once per agent, including one that never completed a turn. */
  skills?: AgentSkillsRecord[];
  /** Where each pane agent's pane went, once per agent. Absent when the run placed none. */
  panes?: AgentPaneRecord[];
  /** Every decision the run asked, in the order asked. Absent when it asked none. */
  decisions?: SettledDecision[];
  /** Each stage the attempt entered, as its attempt file has them; absent when none. */
  stages?: AttemptStage[];
  /** The workflow's Markdown report, when it wrote one. */
  report?: string;
} & (
  | { outcome: "completed"; value: JsonValue }
  /** Parked: its last wait's label and `until`, an ISO time, as its mailbox records them. */
  | { outcome: "parked"; label?: string; until?: string }
  | {
      outcome: UnfinishedOutcome;
      reason: string;
      /** The stage the attempt ended in; absent when it ended between stages. */
      stage?: string;
      /** The stages whose values it stopped for, to start at a later one, in the order reached. */
      needs?: StageNeed[];
    }
);

export const ALLOWANCE_VERSION = "awf.allowance/1";

/** What `awf allowance --json` prints: each harness's plan, as the harness itself showed it. */
export type AllowanceReport = {
  version: typeof ALLOWANCE_VERSION;
  /** When the reads started, ISO 8601. */
  readAt: string;
  harnesses: HarnessAllowance[];
};

/**
 * One harness's plan, or why it has none to read: no reader, no login, a login that is billed per
 * token, or a read that failed. A `none` is unknown, not room to spare.
 */
export type HarnessAllowance =
  | {
      harness: HarnessKind;
      read: "plan";
      /** What was read: `claude /usage`, `codex account/rateLimits/read`, `cursor /usage`. */
      source: string;
      /** The plan's name, as the harness words it: `max`, `prolite`, `Team`. */
      plan?: string;
      /** Its tier within the plan, where the harness tells one apart: `default_claude_max_20x`. */
      tier?: string;
      windows: AllowanceWindow[];
    }
  | { harness: HarnessKind; read: "none"; reason: string };

/** A limit of the plan's, over a window that resets. Nothing the harness did not show is filled in. */
export type AllowanceWindow = {
  /** Named from the harness's wording, unique within it: `session`, `week`, `included`. */
  id: string;
  /** As the harness words it. */
  label: string;
  usedPercent: number;
  /** When it resets, ISO 8601 in UTC; as precise as the harness shows it. */
  resetsAt?: string;
  /** The models it alone limits, as the harness names them; absent, it limits every model. */
  models?: string[];
};

export const OPERATION_LIVENESS_RECORD_VERSION = 1 as const;

/**
 * Messaging's kinds: `awaiting-reply`, a turn ended with its operation awaiting `peer`'s answer until
 * `until`; `continued`, a delivery went on with it, `reason` saying what (`reply`, `no-reply`,
 * `request`, `messages`); `reminder-due`, a turn ended owing an answer; `deadline-extended`, its
 * deadline moved later, to `until`: a message operation's for the askers it answers, a workflow's by
 * a wait on an outside participant.
 */
export const OPERATION_LIVENESS_KINDS = [
  "opened",
  "waiting",
  "admitted",
  "persisted",
  "dispatched",
  "queue-accepted",
  "received",
  "check-in-due",
  "awaiting-reply",
  "continued",
  "reminder-due",
  "deadline-extended",
  "releasing",
  "release",
  "terminal",
] as const;
export type OperationLivenessKind = (typeof OPERATION_LIVENESS_KINDS)[number];

/** Optional diagnostics in calls/{operationId}/liveness.jsonl; never settlement authority. */
export type OperationLivenessRecord = {
  version: typeof OPERATION_LIVENESS_RECORD_VERSION;
  operationId: string;
  kind: OperationLivenessKind;
  /** Unix milliseconds, sampled by the engine. */
  at: number;
  /** Check-in ordinal: zero is the initial prompt; several events share an ordinal. */
  sequence: number;
  reason?: string;
  until?: number;
  /** On `awaiting-reply`, whose answer the operation awaits. */
  peer?: AgentKey;
  /** Events omitted since the previous successfully written record. */
  dropped?: number;
  truncated?: true;
};
