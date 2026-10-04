import type { Billing, SettledOperation } from "@agentswf/contract/records";
import type {
  AbsoluteDeadline,
  AgentExecution,
  AgentKey,
  OperationRecord,
} from "@agentswf/contract/workflow";
import type { SessionAccounting, SessionRead, UsageRecord } from "@agentswf/harness";
import type { HarnessTurnOutcome } from "@agentswf/harness/adapter";
import { spendOf } from "./accounting/tokens";
import { abortableSleep, deadlineWithin, runUntilStopped, waitForDeadline } from "./deadlines";

/**
 * How long a finished run waits for turns still ending after their answer. Closing the host kills
 * them, and a request cut off that way is never logged; a closing message takes a few seconds.
 * It bounds the run's end, so it is shorter than the host's own grace for a turn left finishing
 * while the run goes on.
 */
const FINISHING_GRACE_MILLISECONDS = 10_000;
/** Reading spend waits for files a released turn is still writing; it gives up after this. */
const ACCOUNTING_GRACE_MILLISECONDS = 20_000;
/** Beyond that, the host's bound on a billing status command, and this much more. */
const STATUS_SLACK_MILLISECONDS = 2_000;

/** One logical agent, as the run knows it. */
export type AccountedAgent = {
  key: AgentKey;
  execution: AgentExecution;
  /** Where it ran; a sandboxed agent's is set once its sandbox resolves it. */
  cwd: string;
  /** A sandboxed agent's own harness home, where its sessions are. */
  home?: string;
  /** Every native session id seen for the agent so far, from its `wf` calls and its adapter. */
  sessions(): readonly string[];
  /** When its host first prompted it, where that waits on the agent first; see `window`. */
  promptedAt?(): number | undefined;
};

/** One operation's place in the run, held from before its dispatch so records keep that order. */
type OperationEntry = {
  /**
   * Records what is known when the operation settles; spend and billing wait for the run's end.
   * `finishing` is an answered turn the host left finishing, whose charges are added when it ends.
   */
  settle(
    times: { deliveredAt?: number; settledAt: number },
    charges: readonly number[],
    finishing?: Promise<HarnessTurnOutcome>,
  ): OperationRecord;
};

/** Where an operation ran: its workflow stage, absent between stages, and its turn's label. */
export type OperationTags = Pick<OperationRecord, "stage" | "label">;

/** One agent's part of the run's ledger. */
export type AgentLedger = { reserve(operationId: string, tags?: OperationTags): OperationEntry };

export type RunLedger = {
  /** Called in open order, so which agent keeps a request two of them report does not vary. */
  agent(agent: AccountedAgent): AgentLedger;
  /** Every settled operation, with the sessions its agent has been seen with so far. */
  records(): OperationRecord[];
  /** Best effort: a turn still going at the deadline, or when the run is stopped, is killed. */
  letFinish(runDeadline: AbsoluteDeadline, signal: AbortSignal): Promise<void>;
  /**
   * Every record, completed with what its agent spent. Called once the host has closed, because a
   * released turn still writes its last request after the engine has moved on (story 002,
   * experiment 14). Best effort, and after the run's own deadline: a read or status command that
   * fails, overruns its grace or is stopped leaves each record as it settled.
   */
  settle(signal: AbortSignal): Promise<SettledOperation[]>;
};

type Operation = {
  agent: AccountedAgent;
  usage?: Omit<OperationRecord, "sessions">;
  costs: number[];
};
type Settled = Operation & { usage: Omit<OperationRecord, "sessions"> };

export function createRunLedger({
  accounting,
  startedAt,
}: {
  accounting: SessionAccounting | undefined;
  startedAt: number;
}): RunLedger {
  const agents: AccountedAgent[] = [];
  const operations: Operation[] = [];
  const late = new Set<Promise<void>>();
  const settled = () =>
    operations.filter((operation): operation is Settled => operation.usage !== undefined);
  /** Until no turn is left finishing, including one that began finishing during the wait. */
  const lateEnded = async () => {
    let waited = 0;
    while (late.size > waited) {
      waited = late.size;
      await Promise.allSettled([...late]);
    }
  };

  return {
    agent(agent) {
      agents.push(agent);
      return {
        reserve(operationId, tags = {}) {
          const operation: Operation = { agent, costs: [] };
          operations.push(operation);
          return {
            settle(times, charges, finishing) {
              operation.usage = {
                callPath: [],
                agent: agent.key,
                operationId,
                execution: agent.execution,
                ...(times.deliveredAt === undefined
                  ? {}
                  : { deliveredAt: new Date(times.deliveredAt).toISOString() }),
                settledAt: new Date(times.settledAt).toISOString(),
                ...(tags.stage === undefined ? {} : { stage: tags.stage }),
                ...(tags.label === undefined ? {} : { label: tags.label }),
              };
              operation.costs = [...charges];
              if (finishing) {
                late.add(
                  finishing.then(
                    ({ chargesUsd }) => {
                      operation.costs.push(...chargesUsd);
                    },
                    () => undefined,
                  ),
                );
              }
              return withSessions(operation as Settled);
            },
          };
        },
      };
    },

    records: () => settled().map(withSessions),

    async letFinish(runDeadline, signal) {
      await runUntilStopped(
        lateEnded,
        signal,
        deadlineWithin(FINISHING_GRACE_MILLISECONDS, runDeadline),
      ).catch(() => undefined);
    },

    async settle(signal) {
      const endedAt = Date.now();
      const deadline = endedAt + ACCOUNTING_GRACE_MILLISECONDS;
      // The bound below answers without stopping the work; this stops it, so no status command
      // starts once the records are returned.
      const settling = new AbortController();
      try {
        return await runUntilStopped(
          async () => {
            // Closing the host ended every turn left finishing; what each charged lands here.
            await waitForDeadline(lateEnded(), { unixMilliseconds: deadline }).catch(
              () => undefined,
            );
            return await settleUsage(settled(), agents, accounting, {
              startedAt,
              endedAt,
              deadline,
              signal: AbortSignal.any([signal, settling.signal]),
            });
          },
          signal,
          // The grace paces the re-reads; this bounds a read or status command that never returns.
          { unixMilliseconds: deadline + (accounting?.statusMs ?? 0) + STATUS_SLACK_MILLISECONDS },
        );
      } catch {
        return unread(settled());
      } finally {
        settling.abort();
      }
    },
  };
}

/**
 * Reads what every agent spent and gives each operation its share. While any session's turn is
 * still open the files are read again, until that turn closes, it stops changing for `stalledMs`,
 * `deadline` passes or `signal` aborts. Whatever the last read found stands.
 */
async function settleUsage(
  operations: readonly Settled[],
  agents: readonly AccountedAgent[],
  accounting: SessionAccounting | undefined,
  options: { startedAt: number; endedAt: number; deadline: number; signal: AbortSignal },
): Promise<SettledOperation[]> {
  if (!accounting) return unread(operations);
  // An agent opened but never asked anything is not read, so it cannot claim another's requests.
  const asked = agents.flatMap((agent) => {
    const own = operations.filter((operation) => operation.agent === agent);
    return own.length === 0 ? [] : [{ agent, own }];
  });

  const reads = await readUntilSettled(
    asked.map(({ agent }) => agent),
    accounting,
    options,
  );
  // The caller has already answered with the records as they settled; no status command starts.
  if (options.signal.aborted) return unread(operations);
  const claimed = new Set<string>();
  const counted = new Map<AccountedAgent, UsageRecord[] | undefined>();
  for (const { agent } of asked) {
    const { from, until } = window(agent, options);
    counted.set(
      agent,
      reads.get(agent)?.records.filter((record) => {
        const claim = `${agent.execution.harness}\u0000${record.key}`;
        const at = Date.parse(record.at);
        // A resumed session carries requests from before the run, and two agents can name one.
        if (claimed.has(claim) || !(at >= from && at <= until)) return false;
        claimed.add(claim);
        return true;
      }),
    );
  }
  const settledAgents = new Map(
    await Promise.all(
      asked.map(async ({ agent, own }) => {
        const records = counted.get(agent);
        const billing: Billing =
          (await attempt(() => accounting.billing(agent.execution, records))) ?? "unknown";
        return [agent, { billing, shares: records && share(own, records) }] as const;
      }),
    ),
  );

  return operations.map((operation) => {
    const { billing, shares } = settledAgents.get(operation.agent)!;
    const { costs } = operation;
    const charged = billing === "metered" && costs.length > 0 ? sum(costs) : undefined;
    return {
      ...withSessions(operation),
      billing,
      ...(shares ? { spend: spendOf(shares.get(operation.usage.operationId) ?? []) } : {}),
      ...(charged === undefined ? {} : { charged: { amount: charged, currency: "USD" } }),
    };
  });
}

/**
 * When an agent's records are the run's. A calling session's are from the run's first prompt to it
 * until the run's own work ended: before, its turns were the operator's, the one that replied with
 * the run's code included, and so are its turns after the hand-back (ADR 0010). That prompt is the
 * host's, not the operation's delivery, which comes before the host waits for the operator's turn.
 */
function window(
  agent: AccountedAgent,
  options: { startedAt: number; endedAt: number },
): { from: number; until: number } {
  if (!agent.execution.caller) return { from: options.startedAt, until: Number.POSITIVE_INFINITY };
  return { from: agent.promptedAt?.() ?? Number.POSITIVE_INFINITY, until: options.endedAt };
}

async function readUntilSettled(
  agents: readonly AccountedAgent[],
  accounting: SessionAccounting,
  options: { deadline: number; signal: AbortSignal },
): Promise<Map<AccountedAgent, SessionRead | undefined>> {
  const readAll = async () =>
    new Map(
      await Promise.all(
        agents.map(async (agent) => {
          const ids = agent.sessions();
          const read =
            // A sandboxed agent's home names its sessions even when nothing else did.
            ids.length === 0 && !agent.home
              ? undefined
              : await attempt(() => accounting.read(agent.execution, ids, agent.cwd, agent.home));
          return [agent, read] as const;
        }),
      ),
    );
  let latest = await readAll();
  let changedAt = Date.now();
  while (
    [...latest.values()].some((read) => read?.open) &&
    Date.now() - changedAt < accounting.stalledMs &&
    Date.now() + accounting.pollMs < options.deadline &&
    !options.signal.aborted
  ) {
    await abortableSleep(accounting.pollMs, options.signal);
    const next = await readAll();
    if (JSON.stringify([...next.values()]) !== JSON.stringify([...latest.values()])) {
      changedAt = Date.now();
    }
    latest = next;
  }
  return latest;
}

/**
 * An operation owns what its agent logged from its delivery until the next operation's. What came
 * before the first delivery is the first operation's, and so is everything when none was
 * delivered: a share never drops a record.
 */
function share(
  operations: readonly Settled[],
  records: readonly UsageRecord[],
): Map<string, UsageRecord[]> {
  const delivered = operations
    .flatMap(({ usage }) =>
      usage.deliveredAt === undefined
        ? []
        : [{ id: usage.operationId, from: Date.parse(usage.deliveredAt) }],
    )
    .sort((left, right) => left.from - right.from);
  const first = delivered[0]?.id ?? operations[0]!.usage.operationId;
  const shares = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const at = Date.parse(record.at);
    const owner = delivered.findLast((operation) => operation.from <= at)?.id ?? first;
    shares.set(owner, [...(shares.get(owner) ?? []), record]);
  }
  return shares;
}

function withSessions({ usage, agent }: Settled): OperationRecord {
  return {
    ...usage,
    sessions: agent.sessions().map((id) => ({ harness: usage.execution.harness, id })),
  };
}

function unread(operations: readonly Settled[]): SettledOperation[] {
  return operations.map((operation) => ({ ...withSessions(operation), billing: "unknown" }));
}

/** A reader or status command is another package's code: a throw of any kind is "unknown". */
async function attempt<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
