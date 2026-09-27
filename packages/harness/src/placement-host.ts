import { type AgentExecution, type AgentPlacement, placementOf } from "@wf/contract/workflow";
import type { AgentRunHost, AgentRunHostFactory, HarnessRunSnapshot } from "./adapter";
import type { SessionAccounting } from "./usage/accounting";

/**
 * One run host over a pane host and a headless one. Each agent goes to the host its placement
 * names, and each side opens only when an agent first needs it, so a run that is all headless
 * never starts a terminal workspace. The engine still sees one host with one cleanup.
 */
export function createPlacementHostFactory(
  hosts: Readonly<Record<AgentPlacement, AgentRunHostFactory>>,
): AgentRunHostFactory {
  const accounting = placedAccounting(hosts);
  return {
    ...(accounting ? { accounting } : {}),
    async openRun(spec) {
      const opening = new Map<AgentPlacement, Promise<AgentRunHost>>();
      const opened: AgentRunHost[] = [];
      let state: "running" | "closing" | "closed" = "running";
      let closeAttempt: Promise<void> | undefined;
      const side = (placement: AgentPlacement): Promise<AgentRunHost> => {
        let host = opening.get(placement);
        if (!host) {
          host = hosts[placement].openRun(spec);
          opening.set(placement, host);
          void host.then(
            (ready) => opened.push(ready),
            () => undefined,
          );
        }
        return host;
      };
      const host: AgentRunHost = {
        async openAgent(request) {
          if (state !== "running") throw new Error("run host is closed");
          return (await side(placementOf(request.execution))).openAgent(request);
        },
        inspect(): HarnessRunSnapshot {
          return { state, agents: opened.flatMap((side) => side.inspect().agents) };
        },
        async close(reason) {
          if (state === "closed") return;
          closeAttempt ??= (async () => {
            state = "closing";
            // A side still opening is closed once it is up; one that failed to open holds nothing.
            const sides = await Promise.allSettled(opening.values());
            const settled = await Promise.allSettled(
              sides.flatMap((side) =>
                side.status === "fulfilled" ? [side.value.close(reason)] : [],
              ),
            );
            const rejected = settled.filter(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (rejected.length > 0) {
              throw new AggregateError(
                rejected.map((result) => result.reason),
                "run host cleanup failed",
              );
            }
            state = "closed";
          })();
          try {
            await closeAttempt;
          } catch (error) {
            closeAttempt = undefined;
            throw error;
          }
        },
      };
      return host;
    },
  };
}

/**
 * Each agent is read and billed by the side that ran it, since how it ran decides who pays. Both
 * sides build theirs with `createSessionAccounting`, so either one's pacing is the other's.
 */
function placedAccounting(
  hosts: Readonly<Record<AgentPlacement, AgentRunHostFactory>>,
): SessionAccounting | undefined {
  const paced = hosts.pane.accounting ?? hosts.headless.accounting;
  if (!paced) return undefined;
  const of = (execution: AgentExecution) => hosts[placementOf(execution)].accounting;
  return {
    pollMs: paced.pollMs,
    stalledMs: paced.stalledMs,
    statusMs: paced.statusMs,
    async read(execution, sessions, cwd, home) {
      return of(execution)?.read(execution, sessions, cwd, home);
    },
    async billing(execution, records) {
      return (await of(execution)?.billing(execution, records)) ?? "unknown";
    },
  };
}
