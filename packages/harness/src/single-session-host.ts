import type {
  AgentExecution,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  JsonValue,
} from "@agentswf/contract/workflow";
import type {
  AgentRunHost,
  AgentRunHostFactory,
  AgentSessionAdapter,
  AgentState,
  HarnessAgentSnapshot,
  HarnessAuthored,
  HarnessOperationBinding,
  HarnessSession,
  HarnessSessionStatus,
  HarnessTurn,
} from "./adapter";
import type { SessionAccounting } from "./usage/accounting";

/**
 * Places one session adapter behind the run-host seam: per-agent sessions, status snapshots and
 * ordered cleanup, with no topology of its own. The Herdr run host wraps its own adapter in this
 * rather than repeating that bookkeeping.
 */
export function createSingleSessionHostFactory(
  adapter: AgentSessionAdapter,
  accounting?: SessionAccounting,
): AgentRunHostFactory {
  return {
    ...(accounting ? { accounting } : {}),
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
  /** Only for the early "working": a quarantined session refuses the start it would announce. */
  let quarantined = false;
  let closed = false;
  const record = (status: HarnessSessionStatus) => {
    if (!closed) setSnapshot(snapshots, key, execution, status);
  };
  /** The session decides what a turn's end leaves the agent as, a turn left finishing included. */
  const recordSession = () => session.status().then(record, () => undefined);
  // "working" goes up before the call so inspection never lags a turn, and comes down again if
  // the call refuses.
  const begin = async (open: () => Promise<HarnessTurn>): Promise<HarnessTurn> => {
    if (!quarantined) record({ state: "working" });
    try {
      return observeTurn(await open());
    } catch (error) {
      await recordSession();
      throw error;
    }
  };
  const observeTurn = (turn: HarnessTurn): HarnessTurn => ({
    ...turn,
    settled: turn.settled.then(async (outcome) => {
      await recordSession();
      return outcome;
    }),
    nudge: (spec) => begin(() => turn.nudge(spec)),
    async release(reason, deadline, options) {
      const disposition = await turn.release(reason, deadline, options);
      if (disposition.kind === "quarantined") quarantined = true;
      await recordSession();
      return disposition;
    },
  });
  return {
    async status() {
      const status = await session.status();
      record(status);
      return status;
    },
    start: ((
      turn: (AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>) & HarnessAuthored,
      binding: HarnessOperationBinding,
    ) =>
      begin(() =>
        turn.schema
          ? session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
          : session.start(turn as AgentTextTurnSpec, binding),
      )) as HarnessSession["start"],
    compact: (id, prompt, deadline) => begin(() => session.compact(id, prompt, deadline)),
    ...(session.fork
      ? {
          async fork(deadline) {
            record({ state: "working" });
            try {
              return await session.fork!(deadline);
            } finally {
              await recordSession();
            }
          },
        }
      : {}),
    ...(session.sessions ? { sessions: () => session.sessions!() } : {}),
    ...(session.promptedAt ? { promptedAt: () => session.promptedAt!() } : {}),
    async close(reason) {
      await session.close(reason);
      record({ state: "missing" });
      closed = true;
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
