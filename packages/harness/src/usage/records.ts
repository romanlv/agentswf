import type { TokenUsage } from "@agentswf/contract/records";

/** One request, as the harness logged it. `at` is what splits an agent's spend between operations. */
export type UsageRecord = {
  /**
   * The request's own id where the harness logs one; the same request read twice is one. Unique
   * only within one harness, so a key from another harness is another request.
   */
  key: string;
  at: string;
  model: string;
  /** Where the harness names it; pricing and billing can depend on it. */
  provider?: string;
  /** Spent by a subagent the agent started, not by the agent itself. */
  delegated: boolean;
  tokens: TokenUsage;
};

/** What a read of an agent's sessions found. */
export type SessionRead = {
  records: UsageRecord[];
  /**
   * A session's last turn has not ended, and the harness is known to go on writing it after the
   * engine lets go: codex does (story 002, experiment 14). A harness that stops with its process
   * never reports a turn open, since a cut-off turn would never close.
   */
  open: boolean;
};
