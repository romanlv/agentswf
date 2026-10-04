import type { JsonSchema } from "./schema";
import type {
  AgentExecution,
  AgentKey,
  HarnessKind,
  NativeSessionRef,
  OperationRecord,
  SkillSource,
  TurnOutcome,
} from "./workflow/agents";
import type { DecisionRecord, Question } from "./workflow/decisions";
import type { JsonObject, JsonValue } from "./workflow/json";
import type {
  Domain,
  Gitdir,
  SandboxEnvironmentKey,
  SandboxKey,
  SandboxSpec,
} from "./workflow/sandboxes";

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
  /** `mixed` when agents whose billing is known disagree; `unknown` when none is known. */
  billing: Billing | "mixed";
  totals: AccountingFigures;
  /** A stage is the call path and the agent or decision key's prefix before `:`, joined with `/`. */
  byStage: (AccountingFigures & { stage: string; spanMs: number })[];
  byModel: ModelFigures[];
  byAgent: (Omit<AccountingFigures, "decisions"> & {
    callPath: string[];
    agent: string;
    stage: string;
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
};

export const ATTEMPT_RECORD_VERSION = 1 as const;

/** How an attempt ended. `interrupted` is never written: it is an attempt with no ending and no process. */
export type AttemptOutcome = "completed" | "stopped" | "failed" | "timed-out" | "cancelled";

/**
 * `attempts/{n}.json`: one `awf run` of a run. Written whole when the attempt claims its number, and
 * again when it ends, with its ending.
 */
export type AttemptRecord = {
  version: typeof ATTEMPT_RECORD_VERSION;
  n: number;
  /** The file it ran, for the record; never identity. */
  file: string;
  /** The workflow's `meta.version`, when it gives one. */
  workflowVersion?: string;
  flags: { timeout: string; fromStage?: string };
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
};

export const STAGE_RECORD_VERSION = 1 as const;

/** A stage's end: `failed` covers a throw, a value its schema rejects, and a cancellation. */
export type StageOutcome = "succeeded" | "failed";

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
};

export const TURN_RECORD_VERSION = 1 as const;

/**
 * A line of `turns.jsonl`: a turn or compaction as it settled, with the attempt it was in. What it
 * spent is read from its sessions once the attempt ends, so a line has none.
 */
export type TurnRecord = {
  version: typeof TURN_RECORD_VERSION;
  attempt: number;
  agent: AgentKey;
  operationId: string;
  execution: AgentExecution;
  /** Absent between stages. */
  stage?: string;
  label?: string;
  deliveredAt?: string;
  settledAt?: string;
  outcome: TurnOutcome<JsonValue>["kind"];
  /** Its agent's sessions as of then; the last is the one it ran on. */
  sessions: NativeSessionRef[];
};

export const OUTPUT_RECORD_VERSION = 5 as const;

/**
 * A run, as the operator CLI keeps it in `output.json` and prints it with `--json`. A run that
 * failed, timed out or was cancelled keeps what it spent too; only a succeeded one has a value.
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
  /** Every decision the run asked, in the order asked. Absent when it asked none. */
  decisions?: SettledDecision[];
} & (
  | {
      outcome: "succeeded";
      value: JsonValue;
      /** The workflow's Markdown report, when it wrote one. */
      report?: string;
    }
  | {
      /**
       * `cancelled` is the operator stopping the run, and wins over the others. `timed-out` is the
       * run's own deadline ending it; a deadline the workflow set and let escape is `failed`.
       * `stopped` is a stop: the workflow's, or a continue that can't go on as asked.
       */
      outcome: "stopped" | "failed" | "cancelled" | "timed-out";
      error: string;
      /** The stage the run ended in; absent when it ended between stages. */
      stage?: string;
    }
);
