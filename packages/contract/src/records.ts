import type { JsonSchema } from "./schema";
import type {
  InboxCode,
  ParticipantCode,
  ReplyCode,
  SendCode,
  ToolCode,
  ToolFailure,
} from "./wire";
import type {
  AgentExecution,
  AgentKey,
  HarnessKind,
  KeepPane,
  OperationRecord,
  PaneLayout,
  PaneSpec,
  PaneWorkspace,
  SkillSource,
  TurnId,
  TurnOutcome,
} from "./workflow/agents";
import type { HarnessAllowance } from "./workflow/allowance";
import type { DecisionRecord, Question } from "./workflow/decisions";
import type { AgentEnded, EmitOutcome, EventId } from "./workflow/events";
import type {
  AttemptOutcome,
  StageNeed,
  StageSummary,
  UnfinishedOutcome,
} from "./workflow/executable";
import type { JsonObject, JsonValue } from "./workflow/json";
import type {
  Domain,
  Gitdir,
  SandboxEnvironmentKey,
  SandboxKey,
  SandboxSpec,
} from "./workflow/sandboxes";
import type { StageOutcome } from "./workflow/workflow";

/**
 * `ops/{id}/op.json`: what one operation is. `id` is `{key}.{n}`, the `n`th operation of the agent
 * or decision keyed `{key}` in the run, counted from 1 across its attempts, so it is never reused.
 * `at` is when its id was drawn, as it started. The format only; the engine does the I/O.
 * Tier: public, stable.
 */
export type OpRecord = { id: string; attempt: number; at: string; stage?: string } & (
  | ({
      /** A workflow's turn: its prompt, which its answers are checked against with `schema`. */
      kind: "turn";
      question: string;
      schema?: JsonSchema;
    } & AgentOp)
  | ({ kind: "message" | "compact" } & AgentOp)
  /** A decision's: its key is the id's. */
  | { kind: "decision" }
);

/**
 * An agent's operation: whose it is, the settings it ran at and where, which is what its spend is
 * read with, by the attempt that ran it or, for one that attempt never settled, the next.
 * Tier: public, stable.
 */
export type AgentOp = { agent: string; execution: AgentExecution; cwd: string };

/**
 * `ops/{id}/spend.json`: an agent operation's usage, as measured once its sessions were read. It
 * holds no price: a run's cost is priced when its operations are summed, with `op.json`'s attempt
 * and stage. Written once: by the attempt as it ends, or, for an operation it left without one, by
 * the next attempt as it starts. Tier: public, stable.
 */
export type SpendRecord = {
  billing: Billing;
  /** Absent means unknown: its sessions could not be read. */
  spend?: ModelSpend[];
  /** Only what was actually billed per token; decided with `billing`. */
  charged?: Money;
  /** When it reached its agent and when it settled, as the attempt that ran it knew them. */
  deliveredAt?: string;
  settledAt?: string;
  /** The attempt that read it, when not the attempt that ran it. */
  settledBy?: number;
};

/**
 * Which channel carried a candidate value — `control-plane` in production. A string, because
 * candidates recorded by the archived experiments name channels of their own. Tier: diagnostic.
 */
export type CandidateSource = string;

/**
 * Every candidate value, accepted or not, a line of `ops/{id}/answers.jsonl`. A rejection is
 * evidence, so it is never dropped.
 * Tier: diagnostic.
 */
export type Candidate = {
  at: string;
  source: CandidateSource;
  accepted: boolean;
  raw: string;
  error?: string;
};

/** Tier: public, stable. */
export type Money = {
  /** Non-negative amount in `currency`. */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
};

/**
 * Non-negative integer token counts, in classes that are priced differently.
 * Tier: public, stable.
 */
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

/**
 * One model's tokens; `delegated` marks what the agent's own subagents spent.
 * Tier: public, stable.
 */
export type ModelSpend = { model: string; delegated: boolean; tokens: TokenUsage };

/**
 * Who paid for an agent: a plan, or per token. `unknown` only when that could not be told.
 * Tier: public, stable.
 */
export type Billing = "subscription" | "metered" | "unknown";

/**
 * An operation's record once the run has ended and its agent's spend was read. It records no
 * price, so a finished run can be priced again with another table. Records are deliberately
 * self-contained: an agent's sessions and billing repeat on each of its operations, so a flat list
 * can be summarised and re-priced alone. Tier: public, stable.
 */
export type SettledOperation = OperationRecord & {
  billing: Billing;
  /** Absent means unknown. */
  spend?: ModelSpend[];
  /** Only what was actually billed per token; decided with `billing`. */
  charged?: Money;
};

/**
 * What a decision's `ops/{key}.{n}/decision.json` holds: everything asked and answered, so a
 * threshold can be fitted again without calling the model. Tier: public, stable.
 */
export type DecisionArtifact = {
  record: SettledDecision;
  request: { state: string | JsonObject | JsonValue[]; questions: Record<string, Question> };
  /** As `decide` returned them; absent when the call did not answer. */
  answers?: JsonObject;
};

/**
 * A decision once the run has ended: what the provider said it charged, beside its record.
 * Tier: public, stable.
 */
export type SettledDecision = DecisionRecord & {
  /** As the provider reported it; absent when it reported none. */
  charged?: Money;
};

/**
 * What a slice's decisions cost. Kept apart from the agent figures, which count agents: a decision
 * model with no rate folded into those would lower `estimate` with no gap showing.
 * Tier: public, stable.
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

/** One slice of a run: all of it, a stage, or one agent. Tier: public, stable. */
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

/**
 * One model's share. Time and charges belong to an operation, not a model, so are not split.
 * Tier: public, stable.
 */
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

/**
 * What a run cost and how long it took, derived from its settled operations and its two times.
 * Tier: public, stable.
 */
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

/**
 * The sandbox a session lives in, as its `SandboxRecord` has it: enough to open it again where the
 * agent ran, its home under `directory`. Tier: public, stable.
 */
export type SessionSandbox = Pick<SandboxRecord, "provider" | "spec" | "directory" | "provided">;

/**
 * The skills an agent's harness was given: their names, and the directory they were placed in,
 * which its launch points the harness at. Tier: public, stable.
 */
export type SessionSkills = { names: string[]; directory: string };

/** A sandbox a run opened, with every agent it admitted. Tier: public, stable. */
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

/**
 * Where a TUI agent's pane was placed, and why not where its layout said, for the record.
 * Tier: public, stable.
 */
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

/**
 * Where a TUI agent's pane went: its `pane`, or deprecated `layout` and `keepPane`, as the workflow
 * wrote them, and where it was placed, the run's `--workspace` and `--keep-panes` applied.
 * Tier: public, stable.
 */
export type AgentPaneRecord = {
  callPath: string[];
  agent: string;
  pane?: PaneSpec;
  layout?: PaneLayout;
  keepPane?: KeepPane;
  placed: PanePlacement;
};

/** One skill an agent was given, as it was copied to it. Tier: public, stable. */
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

/** The skills an agent was given. Tier: public, stable. */
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

/**
 * The version of `run.json`, `run.jsonl`, `in.jsonl` and the attempt files together. A run without
 * it, or with another, is not read.
 */
export const RUN_FORMAT = 1 as const;

/**
 * `run.json`: what a run is, written once as its folder is claimed. A run's status, current stage
 * and last attempt are read off its other files, so none of them is here to go stale.
 * Tier: public, stable.
 */
export type RunRecord = {
  /** A reader that doesn't know it refuses the run. */
  format: typeof RUN_FORMAT;
  /** Unique within its workflow; its folder's name. */
  id: string;
  /** The workflow's `meta.name`, never its file. */
  workflow: string;
  /**
   * As given, not as parsed: a continue prepares it again with the code as it is then. Empty for a
   * run started with `args`.
   */
  argv: string[];
  /** The args a program started it with, as JSON; absent for a run started from argv. */
  args?: JsonValue;
  /** Where every attempt works. */
  cwd: string;
  /** `awf run --sandbox`'s spec, as its file gave it, which every attempt runs in. */
  sandbox: JsonValue | null;
  created: string;
  /** A run of a workflow with `events`: its `cwd` is its project, and its `argv` empty. */
  events?: true;
  /**
   * With `events`, or `args`: the `PATH` it was first started with, which every attempt runs with.
   */
  env?: { PATH: string };
  /**
   * With `events`, or `args`: the file it was first started from; later, its last attempt's
   * `file` says.
   */
  file?: string;
  /** `awf run --workspace` and `--keep-panes`, which every attempt keeps; absent, neither was given. */
  panes?: RunPanes;
};

/**
 * The operator's choices for a run's TUI agents on the host: the workspace their new tabs open in,
 * and whether a pane stays once its agent is done. Each wins over a deprecated `layout` or
 * `keepPane`; absent, those apply, else the run's workspace and `never`. Tier: public, stable.
 */
export type RunPanes = { workspace?: PaneWorkspace; keep?: KeepPane };

/**
 * What a wait took. A timer's id is `awf.timer.{hash}` of its name, which `timer` says; a time read
 * from state's is `awf.at.{hash}` of its branch and time, which `branch` and `due` say.
 * Tier: public, stable.
 */
export type Taken = { id: EventId; timer?: string; branch?: string; due?: string };

/**
 * State saved at a line: each name given takes its value; a name not given keeps its own.
 * Tier: public, stable.
 */
export type Saved = { name: string; value: JsonValue }[];

/**
 * A line of `run.jsonl`, what the run settled, appended by the attempt that holds the run alone.
 * `claimed` is an attempt beginning to write: a line after it from an earlier attempt is ignored.
 * `readRun` is its published reading. Tier: public, stable.
 */
export type RunLine = {
  attempt: number;
  at: string;
} & (
  | { kind: "claimed" }
  /** A stage's end, every outcome; only `succeeded` settles it, a provided stage's included. */
  | {
      kind: "stage";
      name: string;
      outcome: StageOutcome;
      reason?: string;
      started: string;
      summary?: string;
      value?: JsonValue;
      /** Its value was given, not run: written `succeeded` with `provided`. */
      provided?: true;
      /**
       * The stage its attempt started at: the one `--from-stage` named, or a plain run's first stage
       * not reused. A stage entered after it whose line an earlier attempt wrote runs again.
       */
      redo?: true;
      state?: Saved;
    }
  /** A race's winner, and what it took. */
  | { kind: "race"; name: string; branch: string; took: Taken[] }
  /** A timer as first called; cancelled, the same line again with `cancelled`. */
  | { kind: "timer"; name: string; due: string; when: string; cancelled?: true }
  /** What a wait returned: held until a later wait acknowledges it, or a stage's own. */
  | { kind: "took"; took: Taken[]; stage?: string }
  /** A wait: what it waits for and, outside a stage and a race, what it acknowledges and saves. */
  | {
      kind: "wait";
      label?: string;
      takes?: WaitTake[];
      stage?: string;
      race?: string;
      acks?: EventId[];
      state?: Saved;
      returns?: true;
    }
  /** A turn `start()` began, whose end a wait takes. */
  | {
      kind: "turn-started";
      agent: AgentKey;
      turn: TurnId;
      meta: JsonValue;
      execution: AgentExecution;
    }
  /** That turn's end: `began` is the attempt that started it, `end` what the code was handed. */
  | {
      kind: "turn-ended";
      id: EventId;
      agent: AgentKey;
      turn: TurnId;
      began: number;
      end: AgentEnded;
    }
  /**
   * An agent's native session, as soon as it is known, and where it lives: the agent's own harness
   * home, the sandbox that home is in, and the skills its harness was given, as `awf open` reopens
   * them (story 042).
   */
  | {
      kind: "session";
      agent: AgentKey;
      harness: HarnessKind;
      session: string;
      operation?: string;
      home?: string;
      sandbox?: SessionSandbox;
      skills?: SessionSkills;
    }
);

/**
 * A line of `in.jsonl`, an event the run's code takes, appended by a sender under the run's lock.
 * Names stay as awf records them (`participant:reply`, `agent:ended`). Tier: public, stable.
 */
export type EventLine = {
  at: string;
  id: EventId;
  name: string;
  data: JsonValue;
  from: string;
  /** The event that created its run. */
  starts?: true;
  /** The integration that sent it, as `awf emit --source` names it. */
  source?: string;
};

export {
  type RunView,
  readRun,
  type StageLine,
  type StageView,
  type TimerView,
} from "./run-lines";

/**
 * `attempts/{attempt}.json`: an attempt of a run. Most are a `ClaimedAttempt`; a background launch
 * that never claimed its number is a `FailedLaunch`, its `kind` the one field to tell them
 * apart by. Tier: public, stable.
 */
export type AttemptRecord = ClaimedAttempt | FailedLaunch;

/**
 * One `awf run` of a run. Written whole when the attempt claims its number, and again when it ends,
 * with its ending. Tier: public, stable.
 */
export type ClaimedAttempt = {
  attempt: number;
  kind: "attempt";
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
  /** The background launch that started it, `AWF_LAUNCH`: its output is `launches/{launch}.log`. */
  launch?: string;
  started: string;
  ended?: string;
  outcome?: AttemptOutcome;
  /** The stage the attempt ended in; absent when it ended between stages. */
  stage?: string;
  /** Why it did not complete. */
  reason?: string;
  /**
   * A completed attempt's: the run's return value. Its stages are `run.jsonl`'s, what no wait
   * took is counted from its `took` and `wait` lines, and its cost is its operations' `spend.json`.
   */
  value?: JsonValue;
  /** The messaging ceilings in force; absent on attempts an earlier awf ran. */
  messageLimits?: MessageLimits;
};

/**
 * A start or continue that `awf emit` or `awf tick` launched in the background and that exited
 * before it claimed its number, such as a file that no longer loads: linked by its launcher as the
 * attempt it would have been, failed, with no process. Counted towards `stuck`; nothing else reads
 * it as an attempt that ran. Tier: public, stable.
 */
export type FailedLaunch = {
  attempt: number;
  kind: "failed-launch";
  /** The launch, whose output is `launches/{launch}.log`. */
  launch: string;
  /** The file it tried to run. */
  file: string;
  started: string;
  ended: string;
  outcome: "failed";
  reason: string;
};

/**
 * What a run's total sums of each attempt's accounting: the totals and stages, not who spent it.
 * Tier: public, stable.
 */
export type AttemptAccounting = Pick<
  RunAccounting,
  "basis" | "wallMs" | "grouping" | "billing" | "totals" | "byStage" | "unpriced"
>;

/**
 * A stage an attempt entered, as `out.json` shows it: no value, which its stage line holds.
 * Tier: public, stable.
 */
export type AttemptStage = Omit<StageSummary, "value">;

export type { StageNeed } from "./workflow/executable";

export const TURN_RECORD_VERSION = 1 as const;

/** What a line of `log.jsonl` keeps of its operation's record: not its sessions, which are `run.jsonl`'s. */
export const TURN_OPERATION_FIELDS = [
  "agent",
  "operationId",
  "execution",
  "stage",
  "label",
  "deliveredAt",
  "settledAt",
  "cause",
] as const satisfies readonly (keyof OperationRecord)[];

/**
 * A line of `log.jsonl`: a turn, nudges included, or a compaction, as it settled, with the attempt
 * it was in. The sessions it ran on are `run.jsonl`'s `session` lines: its agent's current at its
 * start, and every one naming it. What it spent is read from its sessions once the attempt ends, so
 * a line has none. Tier: public, for reading.
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
 * them. Observation only: `--continue` never reads it (ADR 0011). Tier: public, for reading.
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
  /** Written at delivery. */
  | ({ kind: "operation-started" } & OperationEvent)
  /** May have no start: an operation can fail before it is delivered. */
  | ({ kind: "operation-failed"; error: string } & OperationEvent)
  /**
   * A sandbox opened, as its record stood then: the agents it admits later, and the domains their
   * harnesses add, are on their own `agent-opened` lines.
   */
  | ({ kind: "sandbox-opened" } & SandboxRecord)
  | {
      kind: "agent-opened";
      agent: AgentKey;
      callPath: string[];
      harness: HarnessKind;
      /** Where it runs, a sandbox's when in one: its native files are found by it. */
      cwd: string;
      /** A sandboxed agent's own harness home; absent for the operator's. */
      home?: string;
      /** The sandbox it was admitted to, by key, and the model domains its harness added to it. */
      sandbox?: SandboxKey;
      domains?: Domain[];
      /** The calling session (ADR 0010). */
      caller?: true;
      /** The skills it was given, as `AgentSkillsRecord` has them, with their own home, if any. */
      skills?: Pick<AgentSkillsRecord, "skills" | "home">;
      /** A TUI agent's pane, as its workflow wrote it and where it was placed. */
      pane?: Omit<AgentPaneRecord, "callPath" | "agent">;
    }
  /** With whether its pane was kept, decided as it closed. */
  | ({ kind: "agent-stopped"; agent: AgentKey; callPath: string[]; harness: HarnessKind } & Pick<
      PanePlacement,
      "kept" | "notKept"
    >)
  | {
      kind: "agent-forked";
      agent: AgentKey;
      /** The agent it was copied from; null for a calling session the run never opened. */
      from: AgentKey | null;
      /** The parent's operation it was copied after; null when the parent ran nothing in this run. */
      after: string | null;
    }
  | { kind: "log" | "warning"; text: string; fields?: JsonObject; stage?: string }
  /**
   * `decision` numbers it in the order asked within the attempt; `operation` is its operation's id,
   * which its end carries too.
   */
  | ({ kind: "decision-asked"; decision: number; operation: string } & Pick<
      DecisionRecord,
      "stage" | "key" | "alias" | "provider" | "model"
    >)
  | ({ kind: "decision-ended"; decision: number; operation: string } & Pick<
      DecisionRecord,
      "stage" | "outcome" | "error"
    >)
  | MessagingEvent
);

/**
 * A route's ends, as the workflow granted it: `between` is one route both ways, with one count, its
 * two ends in the order given, which means nothing. A pair has one open route at a time, so its ends
 * name it. An end is an agent's key or an outside participant's. Tier: public, for reading.
 */
export type RouteEnds =
  | { from: AgentKey; to: AgentKey; between?: never }
  | { between: [AgentKey, AgentKey]; from?: never; to?: never };

/**
 * Why a message admitted was never shown: its sender stopped waiting before its peer saw it, its
 * route closed, or the attempt ended. Tier: public, for reading.
 */
export type UndeliveredReason = "withdrawn" | "route-closed" | "attempt-ended";

/**
 * How an owed answer ended: answered with `wfa reply` or `awf reply`; failed (its peer stopped,
 * failed, or still owed it after its reminder); the asker's `--timeout` or its route's passed; the
 * asker finished first, before its peer saw the question (`withdrawn`) or after (`released`), or
 * the outside participant it was owed by was released (`released`); a deadline the workflow set
 * around the asker passed, or its scope was cancelled (`cancelled`); or the attempt ended.
 * Tier: public, for reading.
 */
export type RequestEnd =
  | "replied"
  | "failed"
  | "timed-out"
  | "withdrawn"
  | "released"
  | "cancelled"
  | "attempt-ended";

/**
 * What an outside participant's message came through: `awf run`'s prompt, `awf reply` or
 * `awf send`, a test's script.
 * Tier: public, for reading.
 */
export type OutsideVia = "terminal" | "command" | "test";

/**
 * Messaging in the run's event log, keyed by attempt and `message`, numbered in the order admitted
 * within the attempt. Written by the side that saw each: the engine on admission and its end, the
 * delivery with what the harness confirmed. Tier: public, for reading.
 */
export type MessagingEvent =
  /**
   * An outside participant connected, with the labels the workflow gave it; `to: "code"` when its
   * messages go to the run's code, each recorded in `in.jsonl` as `participant:reply` from its key:
   * its workflow declares `{key}:reply`, or connected it with the deprecated `to: "code"`.
   */
  | {
      kind: "participant-connected";
      callPath: string[];
      participant: string;
      labels?: JsonObject;
      to?: "code";
    }
  /** `participant.post(text)`: `awf inbox`'s `post` item. */
  | { kind: "participant-post"; callPath: string[]; participant: string; id: string; text: string }
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
   * Admitted, before `wfa send`, `wfa reply`, `awf send` or `awf reply` returned. `operationId` is the
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
  /** Refused before admission, with the code `wfa` printed. */
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
  /**
   * A tool call that passed its checks, its handler about to run; `call` is its `ToolCall.id`, which
   * its `tool-ended` carries. `operationId` is the operation it came in.
   */
  | {
      kind: "tool-called";
      call: string;
      callPath: string[];
      stage?: string;
      operationId: string;
      agent: AgentKey;
      tool: string;
      input: JsonObject;
    }
  /**
   * Its end: `result` what the handler returned, absent for nothing; `error` why it failed. After an
   * abort the outcome is the abort's, whatever the handler then did. `durationMs` runs from the
   * handler's start to this record.
   */
  | {
      kind: "tool-ended";
      call: string;
      callPath: string[];
      stage?: string;
      operationId: string;
      agent: AgentKey;
      tool: string;
      outcome: "ok" | ToolFailure;
      result?: JsonValue;
      error?: string;
      durationMs: number;
    }
  /** Refused before the handler ran, with the code `wfa tool` printed; `operationId` absent for `no-operation`. */
  | {
      kind: "tool-refused";
      callPath: string[];
      stage?: string;
      operationId?: string;
      agent: AgentKey;
      tool: string;
      code: ToolCode;
      /** What `wfa tool` printed for `invalid-input`: the schema's errors, or the usage line's. */
      error?: string;
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

/**
 * The messaging ceilings an attempt ran under. A route's `maxMessages` may only lower `perRoute`.
 * Tier: public, stable.
 */
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

/** A line of `log.jsonl`, the run's event log. Tier: public, for reading. */
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

/**
 * What a wait takes: events of `name`, from `from` when given, and of the turn `turn` when given.
 * A timer's `timer:due` is from its name. A select's time read from state is `at:due` from its
 * branch, with `due`, the ISO time read, when the read gave one: a deadline, not part of the match.
 * With no event ready, the wait takes it at once, under id `awf.at.{hash}` of the branch and the
 * time, which its `took` line names with `branch` and `due`. Tier: public, stable.
 */
export type WaitTake = { name: string; from?: string; turn?: string; due?: string };

/**
 * A run of a workflow with `events` at its wait, live or parked: the wait's label, and `until`, an
 * ISO time, when the earliest timer the wait takes is due.
 */
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
  /** Present when the list is cut, as `LogsJson.more` is. */
  more?: { older?: true };
};

/**
 * An agent's state in `awf runs {ref} --json`, from the run's log: `idle` before its first
 * operation, `working` on one, `waiting` in it after `wfa waiting`, `awaiting-reply` in it on a
 * peer's answer, then how its last ended, a `TurnOutcome`'s kind (`failed` too for an operation
 * that failed outside a turn); `stopped` when it stopped while working, and `interrupted` when the
 * run's process went while it worked.
 */
export const AGENT_STATES = [
  "idle",
  "working",
  "waiting",
  "awaiting-reply",
  "answered",
  "unanswered",
  "blocked",
  "timed-out",
  "failed",
  "cancelled",
  "stopped",
  "interrupted",
] as const;
export type AgentStateJson = (typeof AGENT_STATES)[number];

/**
 * A stage's state in `awf runs {ref} --json`: `running`, `interrupted` when the run's process went
 * while it ran, `reused` or `provided` from an earlier attempt or `--values`, or how it ended.
 */
export const STAGE_STATES = [
  "running",
  "interrupted",
  "reused",
  "provided",
  "succeeded",
  "stopped",
  "failed",
] as const;
export type StageStateJson = (typeof STAGE_STATES)[number];

/**
 * `awf runs {ref} --json`: durable fields, and best effort under each agent's `live`. Version 2
 * made an agent's `state` one of `AGENT_STATES`, and a stage's one of `STAGE_STATES`.
 */
export type RunJson = {
  v: 2;
  run: RunHeadJson & { estimate?: number; dir: string };
  attempts: {
    attempt: number;
    started: string;
    ended?: string;
    state: RunStateJson;
    stage?: string;
    reason?: string;
  }[];
  stages: {
    stage: string;
    state: StageStateJson;
    started?: string;
    ended?: string;
    /** Its `stage` line's value, a reused stage's the line it reused; absent when it has none. */
    value?: JsonValue;
  }[];
  agents: {
    key: AgentKey;
    harness?: HarnessKind;
    caller?: true;
    stage?: string;
    state: AgentStateJson;
    turns: number;
    sessions: { harness: HarnessKind; id: string; files: string[] }[];
    live: {
      /** `waiting` after `wfa waiting`; `awaiting-reply` on `peer`'s answer. */
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
  | (DistributiveOmit<RunLogLine, "version"> & {
      operation?: string;
      /** A turn or compaction that ended without an answer: the file holding what its pane showed. */
      screen?: string;
    })
  /** A `run.jsonl` line that first names a session, its handle `r{n}`. */
  | Extract<RunLine, { kind: "session" }>
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
 * Why a question to a participant closed unanswered, as `awf inbox` reports it, from its
 * `request-ended`: `timed-out` is `timeout`, and the others keep their names. Such a question is
 * shown when recorded, so never `withdrawn`; an outside participant is never reminded and never
 * stops, so never `failed`.
 */
export type InboxExpiry = "timeout" | "released" | "cancelled" | "attempt-ended";

/**
 * One line of `awf inbox --json`, oldest first. Agents are peer addresses, qualified in a child
 * call; message ids are `{attempt}.{n}`, a post's `{attempt}.p{n}`. A reader ignores the kinds and fields it does not know;
 * `v` changes only when one is renamed or removed, or with the command's refusal: version 2 moved
 * with `InboxRefusalJson`'s renames.
 */
export type InboxItemJson = {
  v: 2;
  /** `{workflow}/{id}`. */
  ref: string;
  at: string;
  /** `--after` this reads on from just after the item; absent under `--open`, a snapshot. */
  cursor?: string;
} & (
  | {
      kind: "route";
      state: "opened" | "closed";
      participant: string;
      agent: string;
      /** Which way it carries messages: `both` for `between`, else from or to the participant. */
      direction: "both" | "to-participant" | "from-participant";
      purpose: string;
      /** How long a question on it waits; absent, until it is answered. */
      timeoutMs?: number;
      /** The participant's labels, as the workflow connected it. */
      labels?: JsonObject;
      /** Why it closed. */
      reason?: "stage-ended" | "agent-stopped" | "released" | "attempt-ended";
    }
  | {
      kind: "message";
      participant: string;
      id: string;
      /** One is the participant's key, the other an agent's address. */
      from: string;
      to: string;
      text: string;
      /** A question to the participant, open until an `answered` or `expired` item says otherwise. */
      asks?: true;
      /** When the question closes unanswered, if it has a limit. */
      until?: string;
      /** From the participant, an `awf send` or a script's: what it came through. Its answers are `answered` items. */
      via?: OutsideVia;
    }
  | { kind: "answered"; participant: string; id: string; answer: string; via: OutsideVia }
  /**
   * `participant.post(text)`, to any participant, under `participant`, its key,
   * with the labels the workflow connected it with. Its id, `{attempt}.p{n}`, is new at every
   * attempt: a post a crashed attempt made before its stage was recorded is made again, so a host
   * may see it twice.
   */
  | { kind: "post"; participant: string; id: string; text: string; labels?: JsonObject }
  | { kind: "expired"; participant: string; id: string; reason: InboxExpiry }
  /** `label`: a parked attempt's, as its last `receive` gave it, such as what the run waits for. */
  | { kind: "ended"; attempt: number; outcome: AttemptOutcome | "interrupted"; label?: string }
);

/**
 * `awf reply --json` and `awf send --json`: delivered, with the `id` an `awf inbox` item names (for
 * a reply, the question answered, as its `answered` item has it; for a send, the new message), or
 * a refusal, `ambiguous`'s with its `choices`. Version 2 renamed the refusal `stopped` to
 * `peer-stopped`, as `wfa` has it; version 3 took `code: "delivered"` off the success, as only a
 * refusal has a code, and renamed `not-found` to `no-run`. The deprecated `awf send --event-id`
 * prints `EmitResultJson` instead when it worked.
 */
export type ParticipantResultJson =
  | { v: 3; id: string }
  | RefusalJson<ParticipantCode | RefusalCode, 3>;

/** What `wake` did to a run: started, nudged or continued it, or nothing. */
export type WakeDid = "started" | "nudged" | "continued" | "none";

/**
 * Why an event was refused, or `wake` did nothing: the run returned; no run, and the event doesn't
 * start one; stuck, stopped or cancelled, which need the operator; parked with nothing due; a live
 * run's nudge that failed, whose wait takes the event anyway; an attempt that never started.
 */
export type WakeWhy =
  | "returned"
  | "not-a-start"
  | "stuck"
  | "stopped"
  | "cancelled"
  | "nothing-due"
  | "nudge-failed"
  | "launch-failed"
  /** `awf open --no-fork` holds the run's session: the event waits for its exit (story 042). */
  | "opened";

/** `awf emit --json`, and the deprecated `awf send --event-id --json`. */
export type EmitResultJson = {
  v: 1;
  /**
   * The run has the event and needs no one to step in: false when it was refused, or the run
   * wasn't woken for want of a launch (`launch-failed`) or the operator (`stuck`, `stopped`,
   * `cancelled`). Whether a wait takes it now is the workflow's: `nothing-due` is ok.
   */
  ok: boolean;
  outcome: EmitOutcome;
  /** `{workflow}/{id}`. */
  ref: string;
  /** The event's id, as `--event-id` gave it or as awf made it. */
  eventId: string;
  did: WakeDid;
  why?: WakeWhy;
  /** With `launch-failed`: what the attempt said before it exited. */
  error?: string;
};

/** `EmitResultJson.ok`, from what became of the event and why the run wasn't woken, if it wasn't. */
export function emitOk(outcome: EmitOutcome, why: WakeWhy | undefined): boolean {
  return (
    outcome !== "refused" &&
    why !== "launch-failed" &&
    why !== "stuck" &&
    why !== "stopped" &&
    why !== "cancelled"
  );
}

/**
 * `awf open -p --json`: the answer to one question, asked of a copy of an agent's session or of
 * the session itself.
 */
export type OpenResultJson = {
  v: 1;
  /** The session asked: the copy, or with `--no-fork` the agent's own. */
  session: string;
  /** The agent's session the copy was made from; absent when none was made. */
  forkedFrom?: string;
  reply: string;
  /** The command that asks the same session again. */
  again: string;
};

/** `awf tick --json`: each run it woke, in the order woken. */
export type TickResultJson = {
  v: 1;
  woke: {
    /** `{workflow}/{id}`. */
    ref: string;
    /** `started` for a run whose first attempt never started, as its launch failed. */
    did: "started" | "continued";
    why: "event" | "timer" | "crashed" | "failed";
  }[];
  /** Runs with events whose record can't be read, so not woken; `awf runs` says why. */
  unreadable?: string[];
};

/**
 * `awf inbox --json`'s last line when it read nothing. Version 2 renamed `not-found` to `no-run`
 * and `bad-cursor` to `cursor`, its items moving with it.
 */
export type InboxRefusalJson = RefusalJson<InboxCode | RefusalCode, 2>;

/**
 * Why a `--json` command failed, one meaning each, and the words `ClientError` throws for the same
 * failures: `usage`, an argv that can't be parsed or whose options clash; `no-run`; `ambiguous`, a
 * name that fits more than one, with `choices` when they are known; `file`, a workflow file that is
 * missing, doesn't load or doesn't export the workflow; `event`, an event name, data or source the
 * workflow doesn't take, or a workflow that takes none; `id`, a run or event id the grammar
 * refuses, one `id(args)` returns, or one another run has; `no-id`, a start naming no run;
 * `prepare`, a workflow refusing its arguments or options, or its `id(args)` throwing;
 * `not-started`, no attempt started: a Ctrl-C, a session not taken, a claim given up, or a run that
 * is running or completed, or whose working folder is gone; `other-args`, a start or continue of a
 * run there with other args or options; `unreachable`, a run whose files can't be read or written,
 * a new one's folder included, or that doesn't answer; `cursor`, a cursor or handle that doesn't
 * fit: made for another run or filter, past the run's end, or naming no event; `project`, a
 * workflow in no project; `no-engine` and `other-engine`, a project's `agentswf` missing or another
 * version; `internal-error`, a failure that is neither the caller's nor the run's, such as awf's
 * own record of projects not written, which `error` names; `no-session`, an agent `awf open` names
 * with no session recorded in the run, or a session that is another agent's; `live`, `awf open
 * --no-fork`, or a sandboxed agent's, on a run whose attempt is running; `opened`, a run another
 * `awf open --no-fork` holds, or a sandbox another `awf open` has open. `reply` and `send` also refuse with
 * `PARTICIPANT_CODES`, and `inbox` with `INBOX_CODES`.
 */
export const REFUSAL_CODES = [
  "usage",
  "no-run",
  "ambiguous",
  "file",
  "event",
  "id",
  "no-id",
  "prepare",
  "not-started",
  "other-args",
  "unreachable",
  "cursor",
  "project",
  "no-engine",
  "other-engine",
  "internal-error",
  "no-session",
  "live",
  "opened",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * What a `--json` command prints last when it failed, in place of its result: no result has
 * `code`. `v` is the command's own; `error` is the sentence stderr prints, without `awf: `.
 */
export type RefusalJson<Code extends string = RefusalCode, V extends number = number> = {
  v: V;
  code: Code;
  error: string;
  /** With `ambiguous`: the names to choose from, when they are known. */
  choices?: string[];
};

/** Each kind's own version, which changes when that kind's shape does. */
export const RUN_EVENT_VERSIONS = {
  "attempt-started": 1,
  "attempt-ended": 1,
  "stage-started": 1,
  "stage-ended": 1,
  "operation-started": 1,
  "operation-failed": 1,
  "sandbox-opened": 1,
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
  "participant-connected": 2,
  "participant-post": 1,
  "tool-called": 1,
  "tool-ended": 1,
  "tool-refused": 1,
} as const satisfies Record<RunEvent["kind"], number>;

/** A kind whose older lines are a strict subset of its current shape, read as the current one. */
const RUN_EVENT_OLDEST_READ: Partial<Record<RunEvent["kind"], number>> = {
  "participant-connected": 1,
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
 * An attempt, as the operator CLI keeps it in `out.json` and prints it with `--json`, in the
 * words of its attempt file: a view, written from what the attempt held, its `accounting` priced
 * with the table it ran with. One that didn't complete keeps what it spent too; only a completed
 * one has a value. Tier: public, stable.
 */
export type OutputRecord = {
  version: typeof OUTPUT_RECORD_VERSION;
  /** The run's ref, `{workflow}/{runId}`, as the other run documents carry it; absent in a file written before it was added. */
  ref?: string;
  /** The run's id, the same in every attempt. */
  runId: string;
  /** The attempt that wrote this record: `out.json` is the last ended attempt's. */
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
  /** Where each TUI agent's pane went, once per agent. Absent when the run placed none. */
  panes?: AgentPaneRecord[];
  /** Every decision the run asked, in the order asked. Absent when it asked none. */
  decisions?: SettledDecision[];
  /** Each stage the attempt entered, in order, ran or reused; absent when none. */
  stages?: AttemptStage[];
  /** The workflow's Markdown report, when it wrote one. */
  report?: string;
} & (
  | { outcome: "completed"; value: JsonValue }
  /** Parked: its last wait's label, and `until`, when the earliest timer it takes is due. */
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

export type { AllowanceWindow, HarnessAllowance } from "./workflow/allowance";

/** What `awf allowance --json` prints: each harness's plan, as the harness itself showed it. */
export type AllowanceReport = {
  v: 1;
  /** When the reads started, ISO 8601. */
  readAt: string;
  harnesses: HarnessAllowance[];
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
/** Tier: diagnostic. */
export type OperationLivenessKind = (typeof OPERATION_LIVENESS_KINDS)[number];

/**
 * Optional diagnostics in ops/{operationId}/live.jsonl; never settlement authority.
 * Tier: diagnostic.
 */
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
