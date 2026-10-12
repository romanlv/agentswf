import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Activity, RunLogLine } from "@agentswf/contract/records";
import type { AgentKey, HarnessKind } from "@agentswf/contract/workflow";
import { findHarness, harnessState, readActivity } from "@agentswf/harness";
import { readNumberedEvents } from "./runs";

/**
 * A native session the run's log names, numbered by the line that first named it, so a session
 * named later never renumbers the others. Its files are found under its agent's home and working
 * directory: a sandbox's, for an agent in one.
 */
export type NativeSession = {
  n: number;
  harness: HarnessKind;
  id: string;
  agent?: AgentKey;
};

/** A span of time, open while it has no end. */
type Span = { from: number; to?: number };

/** What the log says of an agent: where its files are, and the spans its activity is the run's. */
export type RunAgent = {
  key: AgentKey;
  cwd?: string;
  home?: string;
  caller: boolean;
  operations: (Span & { id: string })[];
  /**
   * Each time the run held it: from its opening, its fork, or, in a log an earlier awf wrote, its
   * first delivery, to its stop or its attempt's last line.
   */
  windows: Span[];
};

export type RunLog = {
  lines: { number: number; line: RunLogLine }[];
  sessions: NativeSession[];
  agents: Map<AgentKey, RunAgent>;
};

/** `ended`: no attempt is running, so a span still open on the calling session ended with it. */
export async function readRunLog(
  runDir: string,
  options: { ended?: boolean } = {},
): Promise<RunLog> {
  const lines = await readNumberedEvents(runDir);
  const sessions: NativeSession[] = [];
  const agents = new Map<AgentKey, RunAgent>();
  const agentOf = new Map<string, AgentKey>();
  const agent = (key: AgentKey) => {
    const found = agents.get(key) ?? { key, caller: false, operations: [], windows: [] };
    agents.set(key, found);
    return found;
  };
  const open = (held: RunAgent, from: number) => {
    if (held.windows.at(-1)?.to === undefined && held.windows.length > 0) return;
    held.windows.push({ from });
  };
  const name = (harness: HarnessKind, id: string, key?: AgentKey) => {
    const known = sessions.find((each) => each.harness === harness && each.id === id);
    if (known) {
      if (key && !known.agent) known.agent = key;
      return;
    }
    sessions.push({ n: sessions.length + 1, harness, id, ...(key ? { agent: key } : {}) });
  };
  // An attempt that died left its spans open. An agent's end where the next attempt begins; the
  // calling session's at the dead attempt's last line, past which its file is the operator's.
  let attempt: number | undefined;
  let lastAt: number | undefined;
  const closeAll = (at: number, callerAt = at) => {
    for (const held of agents.values()) {
      const end = held.caller ? callerAt : at;
      for (const span of [...held.windows, ...held.operations]) span.to ??= end;
    }
  };
  for (const { line } of lines) {
    const at = Date.parse(timeOf(line));
    if (attempt !== undefined && line.attempt !== attempt && lastAt !== undefined) {
      closeAll(at, lastAt);
    }
    attempt = line.attempt;
    if (!Number.isNaN(at)) lastAt = at;
    switch (line.kind) {
      case "agent-opened": {
        const opened = agent(line.agent);
        opened.cwd = line.cwd;
        if (line.home !== undefined) opened.home = line.home;
        if (line.caller) opened.caller = true;
        else open(opened, at);
        break;
      }
      case "agent-forked":
        open(agent(line.agent), at);
        break;
      case "agent-stopped": {
        const window = agent(line.agent).windows.at(-1);
        if (window && window.to === undefined) window.to = at;
        break;
      }
      case "operation-started": {
        const started = agent(line.agent);
        const from = Date.parse(line.deliveredAt ?? line.at);
        if (!started.caller) open(started, from);
        started.operations.push({ id: line.operationId, from });
        agentOf.set(line.operationId, line.agent);
        for (const session of line.sessions) name(session.harness, session.id, line.agent);
        break;
      }
      case "session-known": {
        const key = line.agent ?? (line.operationId ? agentOf.get(line.operationId) : undefined);
        name(line.session.harness, line.session.id, key);
        break;
      }
      case "turn":
      case "compact": {
        const settled = agent(line.agent);
        const to = line.settledAt ? Date.parse(line.settledAt) : undefined;
        const started = settled.operations.find((each) => each.id === line.operationId);
        // A line an earlier awf wrote has no start before it: its span is its own times.
        if (started) started.to = to ?? at;
        else if (line.deliveredAt) {
          const from = Date.parse(line.deliveredAt);
          open(settled, from);
          settled.operations.push({ id: line.operationId, from, to: to ?? at });
        }
        for (const session of line.sessions) name(session.harness, session.id, line.agent);
        break;
      }
      case "operation-failed": {
        const failed = agents
          .get(line.agent)
          ?.operations.find((each) => each.id === line.operationId);
        if (failed) failed.to = at;
        break;
      }
      case "attempt-ended":
        closeAll(at);
        break;
    }
  }
  if (options.ended && lastAt !== undefined) closeAll(Number.POSITIVE_INFINITY, lastAt);
  return { lines, sessions, agents };
}

const within = (span: Span, at: number) =>
  span.from <= at && (span.to === undefined || at <= span.to);

/** The operation an agent's activity at `at` belongs to: null between them, undefined outside the run. */
function operationAt(agent: RunAgent, at: number): string | null | undefined {
  const inside = agent.operations.find((each) => within(each, at));
  if (inside) return inside.id;
  // The calling session's file is the operator's own conversation outside the run's operations.
  if (agent.caller) return undefined;
  return agent.windows.some((each) => within(each, at)) ? null : undefined;
}

/**
 * A session's files as found, kept between the reads of one command: finding them can list a
 * harness's whole session store. Found again when none were, and now and then after, for the
 * files a session adds as it runs.
 */
export type FileCache = Map<number, { files: SessionFile[]; at: number }>;

const REFIND_MS = 30_000;

/** Without a cursor, a native file is read from this far before its end: a read shows its last events. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** One native file of a session, by a key its name gives, so a late file renumbers nothing. */
export type SessionFile = { session: NativeSession; key: string; path: string };

/** A session's files, the first its own and keyed `""`; none where they cannot be found. */
async function sessionFiles(
  session: NativeSession,
  agent: RunAgent | undefined,
  runCwd: string,
): Promise<SessionFile[]> {
  const spec = findHarness(session.harness);
  if (!spec?.sessionFiles || !spec.activityRow) return [];
  const home =
    agent?.home ?? harnessState()[session.harness as keyof ReturnType<typeof harnessState>];
  if (!home) return [];
  const found = await spec
    .sessionFiles(home, session.id, agent?.cwd ?? runCwd)
    .catch(() => undefined);
  // A codex fork's files name the sessions it was forked from after its own, whose rows are
  // theirs; a session's own files, a claude subagent's too, carry its id in their path.
  const own = (found ?? []).filter(
    (relative, index) => index === 0 || relative.includes(session.id),
  );
  return own.map((relative, index) => ({
    session,
    key: index === 0 ? "" : createHash("sha256").update(relative).digest("hex").slice(0, 12),
    path: join(home, relative),
  }));
}

/**
 * Where a read stopped: the event log's last line number, and each native file's byte offset.
 * Opaque to its holder, who copies it back; versioned, so a later awf can refuse an old one.
 */
export type Cursor = { log: number; files: Record<string, number> };

export function encodeCursor(cursor: Cursor): string {
  return `c1.${Buffer.from(JSON.stringify([cursor.log, cursor.files])).toString("base64url")}`;
}

export function decodeCursor(text: string): Cursor | undefined {
  if (!text.startsWith("c1.")) return undefined;
  try {
    const [log, files] = JSON.parse(Buffer.from(text.slice(3), "base64url").toString("utf8"));
    if (!Number.isSafeInteger(log) || log < 0 || typeof files !== "object" || files === null) {
      return undefined;
    }
    const offsets = Object.entries(files as Record<string, unknown>);
    if (!offsets.every(([, offset]) => Number.isSafeInteger(offset) && (offset as number) >= 0)) {
      return undefined;
    }
    return { log, files: Object.fromEntries(offsets) as Record<string, number> };
  } catch {
    return undefined;
  }
}

/** A file's name in cursors and handles: its session's number, and its key when not the first. */
function fileName(file: Pick<SessionFile, "session" | "key">): string {
  return `a${file.session.n}${file.key ? `-${file.key}` : ""}`;
}

/** An event's handle: its line in the log, or its file and its place in that file. */
export type Handle =
  | { kind: "event"; line: number }
  | { kind: "activity"; file: string; offset: number; index: number };

export function encodeHandle(handle: Handle): string {
  if (handle.kind === "event") return `e${handle.line}`;
  const index = handle.index > 0 ? `.${handle.index}` : "";
  return `${handle.file}.${handle.offset.toString(16)}${index}`;
}

export function decodeHandle(text: string): Handle | undefined {
  const plain = text.startsWith("@") ? text.slice(1) : text;
  const event = /^e([1-9]\d*)$/.exec(plain);
  if (event) return { kind: "event", line: Number(event[1]) };
  const activity = /^(a[1-9]\d*(?:-[0-9a-f]{12})?)\.([0-9a-f]+)(?:\.([1-9]\d*))?$/.exec(plain);
  if (!activity) return undefined;
  return {
    kind: "activity",
    file: activity[1]!,
    offset: Number.parseInt(activity[2]!, 16),
    index: activity[3] ? Number(activity[3]) : 0,
  };
}

/** One event of a read: a line of the log, or an agent's activity, with its handle. */
export type ReadEvent = {
  handle: string;
  at: string;
  /** Sorts by time, then by where it was read. */
  time: number;
} & (
  | { source: "log"; line: RunLogLine }
  | {
      source: "activity";
      agent?: AgentKey;
      operation: string | null;
      activity: Activity;
      text?: string;
    }
);

/**
 * Everything after `cursor`: the log's lines and each session's activity that is the run's, merged
 * by time. The cursor returned is where this read stopped, past nothing torn.
 */
export async function readRun(
  runDir: string,
  runCwd: string,
  cursor: Cursor = { log: 0, files: {} },
  options: {
    full?: boolean;
    ended?: boolean;
    files?: FileCache;
    /** Reads only this native file, by its name in handles; `""` reads none. */
    only?: string;
    /** A read of the newest: each file not in the cursor from its tail, `cut` where it had more. */
    tail?: boolean;
  } = {},
): Promise<{ events: ReadEvent[]; cursor: Cursor; log: RunLog; cut: boolean }> {
  const log = await readRunLog(runDir, options);
  const cache = options.files ?? new Map();
  const now = Date.now();
  let cut = false;
  const events: ReadEvent[] = [];
  let last = cursor.log;
  // The log's lines keep their order among the activity: a turn line's time is its settling,
  // which can come before the line written ahead of it.
  let after = Number.NEGATIVE_INFINITY;
  for (const { number, line } of log.lines) {
    if (number <= cursor.log) continue;
    last = number;
    const at = timeOf(line);
    after = Math.max(after, Date.parse(at) || after);
    events.push({
      handle: encodeHandle({ kind: "event", line: number }),
      at,
      time: after,
      source: "log",
      line,
    });
  }
  const files = { ...cursor.files };
  for (const session of log.sessions) {
    const agent = session.agent ? log.agents.get(session.agent) : undefined;
    const only = options.only;
    if (only !== undefined && only !== `a${session.n}` && !only.startsWith(`a${session.n}-`)) {
      continue;
    }
    let found = cache.get(session.n);
    if (!found || found.files.length === 0 || now - found.at > REFIND_MS) {
      found = { files: await sessionFiles(session, agent, runCwd), at: now };
      cache.set(session.n, found);
    }
    for (const file of found.files) {
      const name = fileName(file);
      if (options.only !== undefined && name !== options.only) continue;
      const read = await readActivity(session.harness, file.path, files[name] ?? 0, {
        ...(options.full ? { full: true } : {}),
        ...(options.tail && files[name] === undefined ? { tail: TAIL_BYTES } : {}),
      });
      if (read.cut) cut = true;
      files[name] = read.offset;
      for (const row of read.rows) {
        const time = Date.parse(row.at);
        const operation = agent ? operationAt(agent, time) : undefined;
        if (operation === undefined) continue;
        events.push({
          handle: encodeHandle({
            kind: "activity",
            file: name,
            offset: row.offset,
            index: row.index,
          }),
          at: row.at,
          time,
          source: "activity",
          ...(session.agent ? { agent: session.agent } : {}),
          operation,
          activity: row.activity,
          ...(row.text === undefined ? {} : { text: row.text }),
        });
      }
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, cursor: { log: last, files }, log, cut };
}

/** When a line happened: an event's time, or a turn's settling. */
export function timeOf(line: RunLogLine): string {
  if ("at" in line && typeof line.at === "string") return line.at;
  return (
    ("settledAt" in line && line.settledAt) || ("deliveredAt" in line && line.deliveredAt) || ""
  );
}
