import type {
  AgentRunHost,
  AgentRunHostFactory,
  AgentSessionAdapter,
  AgentState,
  HarnessAgentSnapshot,
  HarnessSession,
  HarnessSessionStatus,
  HarnessTurn,
  HarnessTurnOutcome,
} from "./adapter";
import type {
  AgentExecution,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  JsonValue,
} from "@wf/contract/workflow";
import type { HarnessOperationBinding } from "./adapter";

/**
 * Temporary migration adapter. It places one existing session adapter behind the final run-host
 * seam; Task 4 replaces this implementation with a host that owns real shared topology.
 */
export function createSingleSessionHostFactory(
  adapter: AgentSessionAdapter,
): AgentRunHostFactory {
  return {
    async openRun() {
      const sessions = new Map<string, HarnessSession>();
      const snapshots = new Map<string, HarnessAgentSnapshot>();
      const pendingActivations = new Set<Promise<void>>();
      const authorities = new Set<string>();
      let state: "running" | "closing" | "closed" = "running";
      let closeAttempt: Promise<void> | undefined;

      const host: AgentRunHost = {
        openAgent(request) {
          if (state !== "running") return Promise.reject(new Error("run host is closed"));
          if (snapshots.has(request.key)) {
            return Promise.reject(new Error(`run host already contains agent ${request.key}`));
          }
          snapshots.set(request.key, {
            key: request.key,
            execution: structuredClone(request.execution),
            state: "starting",
            observedAt: Date.now(),
          });
          const activation = (async () => {
            try {
              const session = await adapter.activate(request);
              if (state !== "running") {
                await session.close("run host closed during activation");
                throw new Error("run host closed during activation");
              }
              const observed = observeSession(
                request.key,
                request.execution,
                session,
                snapshots,
                authorities,
              );
              sessions.set(request.key, observed);
              setSnapshot(
                snapshots,
                request.key,
                request.execution,
                { state: "idle" },
                authorities,
              );
              return observed;
            } catch (error) {
              snapshots.set(request.key, {
                key: request.key,
                execution: structuredClone(request.execution),
                state: "missing",
                observedAt: Date.now(),
                detail: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          })();
          const completion = activation.then(
            () => undefined,
            () => undefined,
          );
          pendingActivations.add(completion);
          void completion.then(
            () => pendingActivations.delete(completion),
            () => pendingActivations.delete(completion),
          );
          return activation;
        },
        inspect() {
          return {
            state,
            agents: [...snapshots.values()].map((snapshot) =>
              redactSnapshot(snapshot, authorities),
            ),
          };
        },
        async close(reason) {
          if (state === "closed") return;
          closeAttempt ??= (async () => {
            state = "closing";
            const settled = await Promise.allSettled([
              ...pendingActivations,
              ...[...sessions.values()].map((session) => session.close(reason)),
            ]);
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

function observeSession(
  key: string,
  execution: AgentExecution,
  session: HarnessSession,
  snapshots: Map<string, HarnessAgentSnapshot>,
  authorities: Set<string>,
): HarnessSession {
  let quarantined = false;
  const record = (status: HarnessSessionStatus) => {
    if (quarantined && status.state !== "quarantined" && status.state !== "missing") return;
    setSnapshot(snapshots, key, execution, status, authorities);
  };
  const observeTurn = (turn: HarnessTurn): HarnessTurn => {
    void turn.settled.then((outcome) => {
      if (!quarantined) record(outcomeStatus(outcome));
    });
    return {
      ...turn,
      async nudge(spec) {
        record({ state: "working" });
        return observeTurn(await turn.nudge(spec));
      },
      async release(reason, deadline) {
        const disposition = await turn.release(reason, deadline);
        if (disposition.kind === "quarantined") quarantined = true;
        record(
          disposition.kind === "quarantined"
            ? { state: "quarantined", detail: disposition.reason }
            : outcomeStatus(disposition.outcome),
        );
        return disposition;
      },
    };
  };
  return {
    capabilities: session.capabilities,
    async status() {
      const status = await session.status();
      record(status);
      return status;
    },
    start: (async (
      turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
      binding: HarnessOperationBinding,
    ) => {
      authorities.add(binding.operationId);
      authorities.add(binding.capability);
      record({ state: "working" });
      const started = turn.schema
        ? await session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
        : await session.start(turn as AgentTextTurnSpec, binding);
      return observeTurn(started);
    }) as HarnessSession["start"],
    async compact(id, prompt, deadline) {
      record({ state: "working" });
      return observeTurn(await session.compact(id, prompt, deadline));
    },
    async close(reason) {
      await session.close(reason);
      record({ state: "missing" });
    },
  };
}

function outcomeStatus(outcome: HarnessTurnOutcome): HarnessSessionStatus {
  switch (outcome.state) {
    case "completed":
      return { state: "idle" };
    case "blocked":
      return { state: "blocked", ...(outcome.detail ? { detail: outcome.detail } : {}) };
    case "cancelled":
      return { state: "dormant", ...(outcome.detail ? { detail: outcome.detail } : {}) };
    case "timed-out":
    case "failed":
      return { state: "unknown", ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }
}

function setSnapshot(
  snapshots: Map<string, HarnessAgentSnapshot>,
  key: string,
  execution: AgentExecution,
  status: { state: AgentState; detail?: string },
  authorities: ReadonlySet<string>,
): void {
  snapshots.set(key, {
    key,
    execution: structuredClone(execution),
    state: status.state,
    observedAt: Date.now(),
    ...(status.detail
      ? {
          detail: containsAuthority(status.detail, authorities)
            ? "agent state has no safe diagnostic detail"
            : status.detail,
        }
      : {}),
  });
}

function redactSnapshot(
  snapshot: HarnessAgentSnapshot,
  authorities: ReadonlySet<string>,
): HarnessAgentSnapshot {
  const copy = structuredClone(snapshot);
  if (copy.detail && containsAuthority(copy.detail, authorities)) {
    copy.detail = "agent state has no safe diagnostic detail";
  }
  return copy;
}

function containsAuthority(text: string, authorities: ReadonlySet<string>): boolean {
  const decodedHex = text.replace(/\\x([0-9a-fA-F]{2})/g, (_match, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16)),
  );
  const decoded = decodedHex.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)),
  );
  return [...authorities].some(
    (authority) => text.includes(authority) || decoded.includes(authority),
  );
}
