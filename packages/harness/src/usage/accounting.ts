import type { Billing } from "@agentswf/contract/records";
import { type AgentExecution, placementOf } from "@agentswf/contract/workflow";
import { type RunProcess, runProcess } from "../command";
import { findHarness } from "../spec";
import { STATUS_TIMEOUT_MS } from "./billing";
import type { SessionRead, UsageRecord } from "./records";

/** What a run host knows about paying for its agents and reading back what they spent. */
export interface SessionAccounting {
  /**
   * `undefined` when none of the sessions could be read, which is unknown rather than zero. Valid
   * only once the host has closed: a headless read takes every turn as finished.
   */
  read(
    execution: AgentExecution,
    sessions: readonly string[],
    cwd: string,
    /** The agent's own harness home, when it ran in a sandbox. */
    home?: string,
  ): Promise<SessionRead | undefined>;
  /** Asked once per agent per run, since the answer can run a status command. */
  billing(execution: AgentExecution, records: readonly UsageRecord[] | undefined): Promise<Billing>;
  /** How often to read again while a turn is still being written. */
  readonly pollMs: number;
  /**
   * How long an open turn may go unchanged before it is taken as abandoned: a pane closed under a
   * running agent leaves its turn open for good.
   */
  readonly stalledMs: number;
  /** The most one `billing` call's status command may take. */
  readonly statusMs: number;
}

/**
 * The harness table's readers and billing, for agents launched through `run`, which is how a status
 * command sees the credentials those agents get.
 */
export function createSessionAccounting(run: RunProcess = runProcess): SessionAccounting {
  return {
    // A released codex turn writes its last request 1.6 s after the engine moves on (story 002,
    // experiment 14), and one model request can go silent for longer than that.
    pollMs: 1_000,
    stalledMs: 10_000,
    statusMs: STATUS_TIMEOUT_MS,
    async read(execution, sessions, cwd, home) {
      const spec = findHarness(execution.harness);
      // A sandboxed agent's home is its own: every session there is its, and only those, found
      // without following a link, count; an id it reports could name one of the operator's.
      const all = home ? ((await spec?.homeSessions?.(home)) ?? []) : sessions;
      if (all.length === 0) return undefined;
      const read = await spec?.readSessionUsage?.(all, cwd, home);
      // A headless agent's process has ended by the time the host has closed, so a turn it left
      // open, such as codex killed once its answer was taken, will never be written to again.
      return read && placementOf(execution) === "headless" ? { ...read, open: false } : read;
    },
    async billing(execution, records) {
      const spec = findHarness(execution.harness);
      if (spec?.meteredHeadless && placementOf(execution) === "headless") return "metered";
      if (!spec?.billing) return "unknown";
      const providers = new Set(records?.flatMap((record) => record.provider ?? []));
      // One answer per agent: an agent that moved between providers may be paid for two ways.
      if (providers.size > 1) return "unknown";
      const [provider] = providers;
      // pi's provider falls back to the model's prefix, and a calling session's model is the
      // operator's, which awf never learns (ADR 0010).
      if (execution.caller && !provider && execution.harness === "pi") return "unknown";
      return spec
        .billing({ model: execution.model, ...(provider ? { provider } : {}), run })
        .catch((): Billing => "unknown");
    },
  };
}
