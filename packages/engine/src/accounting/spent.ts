import type {
  AttemptAccounting,
  ClaimedAttempt,
  OpRecord,
  RunAccounting,
  SettledDecision,
  SpendRecord,
} from "@agentswf/contract/records";
import type { PriceTable } from "./prices";
import { attemptAccounting, type PricedOperation, sumAttempts, summarizeRun } from "./summary";

/** An operation as its folder records it: `op.json`, and its `spend.json` or decision's record. */
export type RecordedOp = { op: OpRecord; spend?: SpendRecord; decision?: SettledDecision };

/** What one attempt's operations recorded, priced now. */
export type AttemptSpent = {
  attempt: number;
  accounting: RunAccounting;
  /** Its agent operations with no `spend.json` yet: their usage is unknown, not zero. */
  unsettled: number;
  /** Its agent operations settled without their usage: their sessions could not be read. */
  unread: number;
};

/**
 * Each attempt's accounting, summed from its operations' records and priced with `prices`: a run is
 * priced when it is summed, never when it is written. An attempt still running, or one interrupted
 * and not yet settled by the next, has `unsettled` operations. One with no `ended` is timed to the
 * last of its operations to start or settle.
 */
export function attemptsSpent(
  ops: readonly RecordedOp[],
  attempts: readonly Pick<ClaimedAttempt, "attempt" | "started" | "ended">[],
  prices: PriceTable,
): AttemptSpent[] {
  return attempts.map(({ attempt, started, ended }) => {
    const own = ops.filter(({ op }) => op.attempt === attempt);
    const usage = own.flatMap(({ op, spend }) =>
      op.kind === "decision" || !spend ? [] : [settledOf(op, spend)],
    );
    const decisions = own.flatMap(({ decision }) => (decision ? [decision] : []));
    const agentOps = own.filter(({ op }) => op.kind !== "decision");
    const finishedAt =
      ended ??
      [
        started,
        ...own.map(({ op }) => op.at),
        ...usage.flatMap((record) => record.settledAt ?? []),
        ...decisions.map((record) => record.settledAt),
      ].reduce((last, at) => (Date.parse(at) > Date.parse(last) ? at : last));
    return {
      attempt,
      accounting: summarizeRun(usage, prices, { startedAt: started, finishedAt }, decisions),
      unsettled: agentOps.filter(({ spend }) => !spend).length,
      unread: agentOps.filter(({ spend }) => spend && spend.spend === undefined).length,
    };
  });
}

/**
 * The attempts before one, for a run's total: each one's accounting as far as it is known, and how
 * many have an operation whose usage isn't, by whether they ended.
 */
export type EarlierSpent = { recorded: AttemptAccounting[]; interrupted: number; ended: number };

/** The attempts before `current` summed, for a run's total beside `current`'s own. */
export function earlierSpent(
  spent: readonly AttemptSpent[],
  attempts: readonly Pick<ClaimedAttempt, "attempt" | "ended">[],
  current: number,
): EarlierSpent {
  const before = spent.filter(({ attempt }) => attempt < current);
  const unknown = before.filter(costUnknown);
  const interrupted = unknown.filter(
    ({ attempt }) => attempts.find((each) => each.attempt === attempt)?.ended === undefined,
  ).length;
  return {
    recorded: before.map(({ accounting }) => attemptAccounting(accounting)),
    interrupted,
    ended: unknown.length - interrupted,
  };
}

/** The attempts that ran, when `awf run` can't read what they spent: each of unknown cost. */
export function unreadEarlier(
  attempts: readonly Pick<ClaimedAttempt, "attempt" | "ended">[],
  current: number,
): EarlierSpent {
  const before = attempts.filter(({ attempt }) => attempt < current);
  const interrupted = before.filter(({ ended }) => ended === undefined).length;
  return { recorded: [], interrupted, ended: before.length - interrupted };
}

/** A run's estimate at list prices, over its attempts: never what was billed. */
export function runEstimate(spent: readonly AttemptSpent[]): number | undefined {
  if (spent.length === 0) return undefined;
  return sumAttempts(spent.map(({ accounting }) => attemptAccounting(accounting))).totals.estimate;
}

/** How many of a run's agent operations have a usage not known, so its estimate is a floor. */
export function unknownOps(spent: readonly AttemptSpent[]): number {
  return spent.reduce((total, each) => total + each.unsettled + each.unread, 0);
}

function costUnknown({ unsettled, unread }: AttemptSpent): boolean {
  return unsettled + unread > 0;
}

function settledOf(op: Extract<OpRecord, { agent: string }>, spend: SpendRecord): PricedOperation {
  return {
    callPath: [],
    agent: op.agent,
    operationId: op.id,
    execution: op.execution,
    sessions: [],
    ...(op.stage === undefined ? {} : { stage: op.stage }),
    ...(spend.deliveredAt === undefined ? {} : { deliveredAt: spend.deliveredAt }),
    ...(spend.settledAt === undefined ? {} : { settledAt: spend.settledAt }),
    billing: spend.billing,
    ...(spend.spend === undefined ? {} : { spend: spend.spend }),
    ...(spend.charged === undefined ? {} : { charged: spend.charged }),
    // What a metered turn was billed is reported as it ends, never after: read by the next
    // attempt, its charge is unknown.
    ...(spend.settledBy !== undefined && spend.billing === "metered"
      ? { chargeUnread: true as const }
      : {}),
  };
}
