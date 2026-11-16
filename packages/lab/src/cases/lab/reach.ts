import type { SandboxRecord } from "@agentswf/contract/records";
import type { TrialRecord } from "../format/records";
import type { AgentReach } from "../format/settings";

export type Reach = NonNullable<TrialRecord["reach"]>;

/** An agent as its `agent-opened` line has it. */
export type OpenedAgent = {
  agent: string;
  harness: string;
  sandbox?: string;
  /** The model domains its harness added to its sandbox. */
  domains?: readonly string[];
};

export type ReachInput = {
  opened: readonly OpenedAgent[];
  /** Every agent the run's sessions and turns name. */
  named: readonly string[];
  /** Each sandbox the run opened: the run record's, else its `sandbox-opened` lines. */
  sandboxes: readonly Pick<SandboxRecord, "key" | "provider" | "spec">[];
  agentReach: AgentReach;
};

/** Harnesses that keep their web tools whatever a sandbox says. */
const KEEPS_WEB = new Set(["cursor"]);

/**
 * Whether `domain` is within `allowed`: the same name, or `*.x` covering `a.x` and `*.a.x`, never
 * `x` itself.
 */
export function covers(allowed: string, domain: string): boolean {
  if (allowed === domain) return true;
  if (!allowed.startsWith("*.")) return false;
  const suffix = allowed.slice(1);
  return domain.endsWith(suffix) && domain.length > suffix.length;
}

/**
 * Every agent of a trial ran in a sandbox reaching no more than `agentReach`: checked after the
 * run from its own records. A check after the fact, not a wall.
 */
export function checkReach({ opened, named, sandboxes, agentReach }: ReachInput): Reach {
  const problems: string[] = [];
  const known = new Set(opened.map((a) => a.agent));
  const keys = new Set(sandboxes.map((sandbox) => sandbox.key));
  for (const agent of opened) {
    if (!agent.sandbox) problems.push(`agent ${agent.agent} ran with no sandbox`);
    else if (!keys.has(agent.sandbox)) {
      problems.push(
        `agent ${agent.agent} ran in sandbox ${agent.sandbox}, which the run's records never open, so its reach is unknown`,
      );
    }
  }
  for (const agent of new Set(named)) {
    if (!known.has(agent)) {
      problems.push(`agent ${agent} has no agent-opened line, so its reach is unknown`);
    }
  }
  const sockets: string[] = [];
  const seen = sandboxes.map((sandbox) => {
    const admitted = opened.filter((a) => a.sandbox === sandbox.key);
    const models = new Set(admitted.flatMap((a) => a.domains ?? []));
    const network = [...(sandbox.spec.network ?? [])];
    for (const domain of network) {
      if (models.has(domain) || agentReach.network.some((allowed) => covers(allowed, domain)))
        continue;
      problems.push(`sandbox ${sandbox.key} reaches ${domain}, which agentReach doesn't list`);
    }
    const webSearch = sandbox.spec.webSearch === true;
    if (!agentReach.webSearch) {
      if (webSearch)
        problems.push(`sandbox ${sandbox.key} keeps web search, which agentReach doesn't allow`);
      for (const agent of admitted.filter((a) => KEEPS_WEB.has(a.harness))) {
        problems.push(
          `agent ${agent.agent} runs ${agent.harness}, which keeps its web tools, and agentReach doesn't allow web search`,
        );
      }
    }
    const own = [...(sandbox.spec.sockets ?? [])];
    sockets.push(...own);
    if (own.length > 0 && !agentReach.sockets) {
      problems.push(
        `sandbox ${sandbox.key} opens sockets ${own.join(", ")}, which agentReach doesn't allow`,
      );
    }
    return {
      key: sandbox.key,
      provider: sandbox.provider,
      network,
      webSearch,
      agents: admitted.map((a) => a.agent),
    };
  });
  return { ok: problems.length === 0, problems, sockets, sandboxes: seen };
}
