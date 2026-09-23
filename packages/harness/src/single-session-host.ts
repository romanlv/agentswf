import type {
  AgentExecution,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  JsonValue,
} from "@wf/contract/workflow";
import type {
  AgentRunHost,
  AgentRunHostFactory,
  AgentSessionAdapter,
  AgentState,
  HarnessAgentSnapshot,
  HarnessOperationBinding,
  HarnessSession,
  HarnessSessionStatus,
  HarnessTurn,
} from "./adapter";
import { outcomeStatus } from "./session-core";

/**
 * Places one session adapter behind the run-host seam: per-agent sessions, status snapshots and
 * ordered cleanup, with no topology of its own. The Herdr run host wraps its own adapter in this
 * rather than repeating that bookkeeping.
 */
export function createSingleSessionHostFactory(
  adapter: AgentSessionAdapter,
): AgentRunHostFactory {
  return {
    async openRun() {
      const sessions = new Map<string, HarnessSession>();
      const snapshots = new Map<string, HarnessAgentSnapshot>();
      const pendingActivations = new Set<Promise<void>>();
      let state: "running" | "closing" | "closed" = "running";
      let closeAttempt: Promise<void> | undefined;

      const host: AgentRunHost = {
        openAgent(request) {
          if (state !== "running") return Promise.reject(new Error("run host is closed"));
          if (snapshots.has(request.key)) {
            return Promise.reject(new Error(`run host already contains agent ${request.key}`));
          }
          setSnapshot(snapshots, request.key, request.execution, { state: "starting" });
          const activation = (async () => {
            try {
              const session = await adapter.activate(request);
              if (state !== "running") {
                await session.close("run host closed during activation");
                throw new Error("run host closed during activation");
              }
              const observed = observeSession(request.key, request.execution, session, snapshots);
              sessions.set(request.key, observed);
              setSnapshot(snapshots, request.key, request.execution, { state: "idle" });
              return observed;
            } catch (error) {
              setSnapshot(snapshots, request.key, request.execution, {
                state: "missing",
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
            agents: [...snapshots.values()].map((snapshot) => structuredClone(snapshot)),
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
): HarnessSession {
  let quarantined = false;
  const record = (status: HarnessSessionStatus) => {
    if (quarantined && status.state !== "quarantined" && status.state !== "missing") return;
    setSnapshot(snapshots, key, execution, status);
  };
  // "working" goes up before the call so inspection never lags a turn, and comes down again if
  // the call refuses: the session's own status is the truth then.
  const begin = async (open: () => Promise<HarnessTurn>): Promise<HarnessTurn> => {
    record({ state: "working" });
    try {
      return observeTurn(await open());
    } catch (error) {
      await session.status().then(record, () => undefined);
      throw error;
    }
  };
  const observeTurn = (turn: HarnessTurn): HarnessTurn => {
    void turn.settled.then((outcome) => {
      if (!quarantined) record(outcomeStatus(outcome));
    });
    return {
      ...turn,
      nudge: (spec) => begin(() => turn.nudge(spec)),
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
    async status() {
      const status = await session.status();
      record(status);
      return status;
    },
    start: ((
      turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
      binding: HarnessOperationBinding,
    ) =>
      begin(() =>
        turn.schema
          ? session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
          : session.start(turn as AgentTextTurnSpec, binding),
      )) as HarnessSession["start"],
    compact: (id, prompt, deadline) => begin(() => session.compact(id, prompt, deadline)),
    async close(reason) {
      await session.close(reason);
      record({ state: "missing" });
    },
  };
}

function setSnapshot(
  snapshots: Map<string, HarnessAgentSnapshot>,
  key: string,
  execution: AgentExecution,
  status: { state: AgentState; detail?: string },
): void {
  snapshots.set(key, {
    key,
    execution: structuredClone(execution),
    state: status.state,
    observedAt: Date.now(),
    ...(status.detail ? { detail: status.detail } : {}),
  });
}
