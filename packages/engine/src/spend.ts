import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type Billing,
  type ClaimedAttempt,
  type DecisionArtifact,
  OP_FILE_VERSIONS,
  type OpRecord,
  type RunLine,
  type SettledOperation,
  type SpendRecord,
} from "@agentswf/contract/records";
import type { AgentExecution } from "@agentswf/contract/workflow";
import type { SessionAccounting, UsageRecord } from "@agentswf/harness";
import { PUBLISHED_PRICES } from "./accounting/prices";
import { type AttemptSpent, attemptsSpent, type RecordedOp } from "./accounting/spent";
import { spendOf } from "./accounting/tokens";
import { runUntilStopped } from "./deadlines";
import { messageOf } from "./errors";
import { isCode, linkNew } from "./files";
import { opFile, readOpFile, spendFile } from "./ops";
import { unfenced } from "./run-policy/waits";
import { ACCOUNTING_GRACE_MILLISECONDS, STATUS_SLACK_MILLISECONDS } from "./run-usage";

/**
 * Each agent operation's `spend.json`: its usage as measured once, while its sessions are there to
 * read, and never priced. Written with `link`, so only one write lands: by the attempt that ran it,
 * as it ends, or by the next attempt, as it starts, for one that attempt left without one.
 */

type AgentOpRecord = Extract<OpRecord, { agent: string }>;

/** A `spend.json` as its writer gives it: its version is added as it is written. */
type SpendFields = Omit<SpendRecord, "version">;

/** A settling past its deadline, or stopped. */
const STOPPED: unique symbol = Symbol("stopped");

/** Writes an operation's `spend.json`, once: false when one is there already. */
export async function writeSpend(
  runDir: string,
  op: string,
  record: SpendFields,
): Promise<boolean> {
  return linkNew(spendFile(runDir, op), { version: OP_FILE_VERSIONS.spend, ...record });
}

/**
 * What an ending attempt keeps of the operations it drew: each settled one's usage, and nothing
 * spent for one that never reached its agent, such as a message withdrawn before it opened. One
 * whose sessions went unread, its read cut short by a stop or its deadline, is left to the next
 * attempt, which reads them again, unless nothing could ever read its harness's sessions. Returns what failed to
 * write.
 */
export async function keepSpend(
  runDir: string,
  attempt: number,
  usage: readonly SettledOperation[],
  options: {
    /** Whether a later attempt could read this operation's sessions: none, and unknown is final. */
    reads(execution: AgentExecution): boolean;
  },
): Promise<string[]> {
  const ops = await readOps(runDir, { decisions: false }).catch(() => []);
  const settled = new Map(usage.map((record) => [record.operationId, record]));
  const failed: string[] = [];
  await Promise.all(
    ops.flatMap(({ op, spend }) => {
      if (op.kind === "decision" || op.attempt !== attempt || spend) return [];
      const record = settled.get(op.id);
      if (record && record.spend === undefined && options.reads(record.execution)) return [];
      const spent: SpendFields = record
        ? recordOf(record)
        : {
            billing: usage.find((each) => each.agent === op.agent)?.billing ?? "unknown",
            spend: [],
          };
      return [
        writeSpend(runDir, op.id, spent).catch((error: unknown) => {
          failed.push(`${op.id}: ${messageOf(error)}`);
        }),
      ];
    }),
  );
  return failed;
}

function recordOf(record: SettledOperation): SpendFields {
  return {
    billing: record.billing,
    ...(record.spend === undefined ? {} : { spend: record.spend }),
    ...(record.reportedCost === undefined ? {} : { reportedCost: record.reportedCost }),
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
  };
}

/**
 * Every operation in `ops/` whose `op.json` reads, with its `spend.json` and a decision's record.
 * A folder whose `op.json` is lost is passed over: its operation failed as it was drawn.
 * `decisions: false` leaves out what decisions used, which an agents' estimate doesn't count.
 * `refuse` throws on an `op.json` or `decision.json` of a version this awf doesn't know, whose
 * operation would otherwise go uncounted; an unreadable `spend.json` is usage unknown either way.
 */
export async function readOps(
  runDir: string,
  options: { decisions?: boolean; refuse?: boolean } = {},
): Promise<RecordedOp[]> {
  const refuse = { refuse: options.refuse === true };
  let names: string[];
  try {
    names = await readdir(join(runDir, "ops"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const read = await Promise.all(
    names.map(async (name): Promise<RecordedOp | undefined> => {
      const op = await readOpFile<OpRecord>(opFile(runDir, name), "op", refuse);
      if (!op) return undefined;
      if (op.kind === "decision") {
        if (options.decisions === false) return { op };
        const artifact = await readOpFile<DecisionArtifact>(
          join(runDir, "ops", name, "decision.json"),
          "decision",
          refuse,
        );
        return artifact ? { op, decision: artifact.record } : { op };
      }
      const spend = await readOpFile<SpendRecord>(spendFile(runDir, name), "spend");
      return spend ? { op, spend } : { op };
    }),
  );
  return read.filter((each) => each !== undefined);
}

/**
 * Each claimed attempt's accounting from its operations, priced with today's table. Rejects when an
 * operation's file is of a version this awf doesn't know: its callers show the cost as unknown.
 */
export async function readSpent(
  runDir: string,
  attempts: readonly ClaimedAttempt[],
  options: { decisions?: boolean } = {},
): Promise<AttemptSpent[]> {
  const ops = await readOps(runDir, { ...options, refuse: true });
  return attemptsSpent(ops, attempts, PUBLISHED_PRICES);
}

/**
 * Settles every agent operation an earlier attempt left without `spend.json`: one interrupted, or
 * whose read was cut short. Called as an attempt starts, once its claim has waited for the
 * previous one and ended its turns, and before any agent opens, while the sessions are still
 * there. Per attempt, the agents with an operation to settle are read in the order they first
 * started one, each request counted once, by the first to log it, as a run's end does. An agent's
 * sessions are its `session` lines of that attempt and the one before it; what they logged from
 * its first operation's start, which keeps a fork's copy of its parent's rows out, until the
 * attempt ended, the next claimed, or now, is shared out by when each operation started. A calling
 * session isn't read: its turns before and after the run are the operator's, and nothing on record
 * says where the run's ended. Bounded as a run's end is: past its grace, or once `signal` aborts,
 * what isn't settled yet is left for a later attempt. What fails is returned, and left too.
 */
export async function settleEarlier(
  runDir: string,
  options: {
    /** The attempt settling them. */
    attempt: number;
    /** The claimed attempts before it. */
    attempts: readonly ClaimedAttempt[];
    /** `run.jsonl`'s lines, as `readRunLines` read them. */
    lines: readonly RunLine[];
    accounting: SessionAccounting | undefined;
    now: number;
    signal?: AbortSignal;
  },
): Promise<{ settled: number; failed: string[] }> {
  const ops = await readOps(runDir, { decisions: false });
  const agentOps = ops.filter(
    (each): each is RecordedOp & { op: AgentOpRecord } => each.op.kind !== "decision",
  );
  const pending = agentOps.filter(
    ({ op, spend }) => op.attempt < options.attempt && spend === undefined,
  );
  const failed: string[] = [];
  let settled = 0;
  if (pending.length === 0) return { settled, failed };
  const { accounting } = options;
  const deadline = {
    unixMilliseconds:
      options.now +
      ACCOUNTING_GRACE_MILLISECONDS +
      (accounting?.statusMs ?? 0) +
      STATUS_SLACK_MILLISECONDS,
  };
  const bounded = <T>(call: () => Promise<T>): Promise<T | typeof STOPPED> =>
    runUntilStopped(call, options.signal, deadline).catch(() => STOPPED);
  const lines = unfenced(options.lines).filter(
    (line): line is SessionLine => line.kind === "session",
  );
  const write = async (op: AgentOpRecord, record: SpendFields) => {
    await writeSpend(runDir, op.id, { ...record, settledBy: options.attempt }).then(
      (wrote) => {
        if (wrote) settled += 1;
      },
      (error: unknown) => failed.push(`${op.id}: ${messageOf(error)}`),
    );
  };
  for (const attempt of [...new Set(pending.map(({ op }) => op.attempt))].sort((a, b) => a - b)) {
    const until = untilOf(attempt, options);
    const own = agentOps
      .filter(({ op }) => op.attempt === attempt)
      .sort((a, b) => Date.parse(a.op.at) - Date.parse(b.op.at));
    const claimed = new Set<string>();
    for (const agent of [...new Set(own.map(({ op }) => op.agent))]) {
      const theirs = own.filter(({ op }) => op.agent === agent);
      const unsettled = theirs.filter(({ spend }) => spend === undefined);
      // A settled agent isn't read again: the window keeps a fork's copy of its rows out.
      if (unsettled.length === 0) continue;
      if (theirs.some(({ op }) => op.execution.caller)) {
        for (const { op } of unsettled) await write(op, { billing: "unknown" });
        continue;
      }
      const from = Date.parse(theirs[0]!.op.at);
      const read = accounting
        ? await bounded(() => readAgent(agent, attempt, theirs, lines, accounting))
        : undefined;
      if (read === STOPPED) return { settled, failed };
      const records = read?.filter((record) => {
        const at = Date.parse(record.at);
        const claim = `${record.harness}\u0000${record.key}`;
        if (claimed.has(claim) || at < from || at > until) return false;
        claimed.add(claim);
        return true;
      });
      const shares = records && share(theirs, records);
      const billings = new Map<string, Billing>();
      for (const { op } of unsettled) {
        const key = JSON.stringify(op.execution);
        let billing = billings.get(key);
        if (billing === undefined) {
          const asked: Billing | typeof STOPPED = accounting
            ? await bounded(() => accounting.billing(op.execution, records))
            : "unknown";
          if (asked === STOPPED) return { settled, failed };
          billing = asked;
          billings.set(key, billing);
        }
        await write(op, {
          billing,
          ...(shares ? { spend: spendOf(shares.get(op.id) ?? []) } : {}),
        });
      }
    }
  }
  return { settled, failed };
}

type SessionLine = Extract<RunLine, { kind: "session" }>;

/**
 * Until when an attempt's agents could have logged: it ended, the next attempt claimed, or now,
 * whichever came first. Now is safe: nothing of the attempt settling them has opened yet.
 */
function untilOf(
  attempt: number,
  options: { attempts: readonly ClaimedAttempt[]; now: number },
): number {
  const record = options.attempts.find((each) => each.attempt === attempt);
  const next = options.attempts.find((each) => each.attempt > attempt);
  return Math.min(
    options.now,
    ...(record?.ended ? [Date.parse(record.ended)] : []),
    ...(next ? [Date.parse(next.started)] : []),
  );
}

/**
 * An agent's usage records in one attempt, read by its `session` lines with each of its
 * operations' own settings and folder; undefined when none could be read. Each record carries the
 * harness it was read for, which a request's key is unique within.
 */
async function readAgent(
  agent: string,
  attempt: number,
  ops: readonly { op: AgentOpRecord }[],
  lines: readonly SessionLine[],
  accounting: SessionAccounting,
): Promise<(UsageRecord & { harness: string })[] | undefined> {
  const found = new Map<string, UsageRecord & { harness: string }>();
  let read = false;
  const places = new Map(
    ops.map(({ op }) => [JSON.stringify([op.execution, op.cwd]), op] as const),
  );
  for (const op of places.values()) {
    const { harness } = op.execution;
    const sessions = lines.filter(
      (line) => line.agent === agent && line.harness === harness && line.attempt <= attempt,
    );
    const during = sessions.filter((line) => line.attempt === attempt);
    // The session it was on as the attempt began, which a crash may have kept it from writing again.
    const before = sessions.findLast((line) => line.attempt < attempt);
    const seen = [...(before ? [before] : []), ...during];
    const ids = [...new Set(seen.map((line) => line.session))];
    const home = seen.findLast((line) => line.home !== undefined)?.home;
    if (ids.length === 0 && home === undefined) continue;
    const records = await accounting
      .read(op.execution, ids, op.cwd, home)
      .then((each) => each?.records)
      .catch(() => undefined);
    if (!records) continue;
    read = true;
    for (const record of records)
      found.set(`${harness}\u0000${record.key}`, { ...record, harness });
  }
  return read ? [...found.values()] : undefined;
}

/**
 * An operation owns what its agent logged from its start until the next one's; what came before
 * the first is the first's, so a share never drops a record.
 */
function share(
  ops: readonly { op: AgentOpRecord }[],
  records: readonly UsageRecord[],
): Map<string, UsageRecord[]> {
  const shares = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const at = Date.parse(record.at);
    const owner = (ops.findLast(({ op }) => Date.parse(op.at) <= at) ?? ops[0]!).op.id;
    shares.set(owner, [...(shares.get(owner) ?? []), record]);
  }
  return shares;
}
