import type { JsonSchema } from "./schema";
import type { AgentExecution, OperationRecord, SkillSource } from "./workflow/agents";
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
 * Which channel carried a candidate value — `control-plane` in production. A string, because the
 * archived experiments name channels of their own and the format should not enumerate them.
 */
export type AttemptSource = string;

/** Every candidate value, accepted or not. A rejection is evidence, so it is never dropped. */
export type Attempt = {
  at: string;
  source: AttemptSource;
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
};

/** One model's share. Time and charges belong to an operation, not a model, so are not split. */
export type ModelFigures = {
  model: string;
  agents: number;
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
  /** A stage is the call path and the agent key's prefix before `:`, joined with `/`. */
  byStage: (AccountingFigures & { stage: string; spanMs: number })[];
  byModel: ModelFigures[];
  byAgent: (AccountingFigures & {
    callPath: string[];
    agent: string;
    stage: string;
    execution: AgentExecution;
    billing: Billing;
  })[];
  /** Models the table has no rate for. Their tokens are counted; their cost is not. */
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

export const OUTPUT_RECORD_VERSION = 2 as const;

/**
 * A run, as the operator CLI keeps it in `output.json` and prints it with `--json`. A run that
 * failed or was cancelled keeps what it spent too; only a succeeded one has a value.
 */
export type OutputRecord = {
  version: typeof OUTPUT_RECORD_VERSION;
  runId: string;
  workflow: { name: string; file: string };
  accounting: RunAccounting;
  usage: SettledOperation[];
  /** The run's artifact directory. */
  artifacts: string;
  /**
   * Each sandbox the run opened, once. Absent when it opened none. Readers must not switch
   * exhaustively over a sandbox's `provider`.
   */
  sandboxes?: SandboxRecord[];
  /** Each agent's skills, once per agent, including one that never completed a turn. */
  skills?: AgentSkillsRecord[];
} & (
  | {
      outcome: "succeeded";
      value: JsonValue;
      /** The workflow's Markdown report, when it wrote one. */
      report?: string;
    }
  | {
      /** `cancelled` is the operator stopping the run; a deadline is `failed`. */
      outcome: "failed" | "cancelled";
      error: string;
    }
);
