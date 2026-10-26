import type { LogEventJson, LogsJson, RouteEnds, RunLogLine } from "@agentswf/contract/records";
import { duration } from "./duration";
import { messageOf } from "./errors";
import {
  clockTime,
  command,
  continueOf,
  currentStage,
  failed,
  masked,
  nextLogs,
  type Out,
  parsePlace,
  type ReadPlace,
  said,
  shellLine,
  span,
  stateWord,
} from "./run-commands";
import {
  type Cursor,
  cutCursor,
  decodeCursor,
  decodeHandle,
  encodeCursor,
  encodeHandle,
  type FileCache,
  type ReadEvent,
  readRun,
  timeOf,
} from "./run-read";
import { findRun, type RunStatus } from "./run-state";
import { describeActivity } from "./run-view";

export const logsUsage = [
  "usage: awf logs [<run>] [@<handle>] [--agent <key>] [--stage <name>] [--after <cursor>]",
  "                [--limit <n>] [--wait <seconds> | --follow] [--full] [--cwd <directory>]",
  "                [--run-root <directory>] [--json]",
  "",
  "What a run did and is doing: its events and what its agents did, read from their own session",
  "files, merged by time. With no run, the newest here. Without --after, the last 40 events; with",
  "it, what came after, oldest first. Every answer ends with the command that gets only what is",
  "new. --wait: with nothing to show yet, wait for the first event, at most that many seconds, up",
  "to 300; --follow prints each event as it comes until the run ends. @<handle> names one event,",
  "and --full prints its text, with common credential shapes masked; --json carries it always.",
  "",
  "Exits 0 on any read that worked, 1 when there is no such run or the cursor or handle does not",
  "fit it, 2 on a usage error, 3 when the run's files could not be read.",
].join("\n");

const DEFAULT_LIMIT = 40;
/**
 * In a page's JSON, how much of a string the run wrote or an agent's native text: enough for a
 * result or a message whole, short of a dumped file. `@{handle}` gives it whole.
 */
const PAGE_TEXT = 50_000;
const MAX_WAIT_SECONDS = 300;
/** After a first new event, how long to wait for the rest of its burst. */
const SETTLE_MS = 1_000;
const POLL_MS = 1_000;

type LogsOptions = {
  ref?: string;
  handle?: string;
  agent?: string;
  stage?: string;
  after?: string;
  limit: number;
  waitSeconds: number;
  follow: boolean;
  full: boolean;
};

/** The clock and the pause between polls, which tests drive. */
export type LogsClock = { now(): number; sleep(ms: number): Promise<void> };

const REAL_CLOCK: LogsClock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

class DoesNotFit extends Error {}

export async function logsCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  clock: LogsClock = REAL_CLOCK,
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.stdout(logsUsage);
    return 0;
  }
  let place: ReadPlace;
  let json: boolean;
  let options: LogsOptions;
  try {
    const parsed = parsePlace(argv, shellCwd);
    place = parsed.place;
    json = parsed.json;
    options = parseLogs(parsed.rest);
    if (options.follow && json) throw new Error("--follow is for reading; --json takes --wait");
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}\n\n${logsUsage}`);
    return 2;
  }
  try {
    const { status, alsoRunning } = await findRun(place.runRoot, options.ref);
    const again = shellLine(command(place, "awf", "logs", status.ref));
    let after: Cursor | undefined;
    if (options.after !== undefined) {
      after = decodeCursor(options.after);
      if (!after)
        throw new DoesNotFit(
          `cursor ${options.after} does not fit this run; start again: ${again}`,
        );
    }
    const read = new Reader(status, after, clock, options.limit * 2, json);
    // Lines are numbered by their place in the file, past any that were skipped.
    if (after && after.log > ((await read.next()).log.lines.at(-1)?.number ?? 0)) {
      throw new DoesNotFit(`cursor ${options.after} does not fit this run; start again: ${again}`);
    }
    if (options.handle !== undefined) return await oneEvent(status, options, json, out, again);
    if (options.follow) return await follow(read, options, place, out, clock);
    return await page(read, alsoRunning, options, place, json, out, clock);
  } catch (error) {
    if (error instanceof DoesNotFit) {
      out.stderr(error.message);
      return 1;
    }
    return failed(error, place, out, messageOf(error));
  }
}

function parseLogs(rest: readonly string[]): LogsOptions {
  const options: LogsOptions = {
    limit: DEFAULT_LIMIT,
    waitSeconds: 0,
    follow: false,
    full: false,
  };
  let waitGiven = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const value = () => {
      const given = rest[index + 1];
      if (given === undefined || given.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return given;
    };
    if (arg === "--agent") options.agent = value();
    else if (arg === "--stage") options.stage = value();
    else if (arg === "--after") options.after = value();
    else if (arg === "--limit") {
      const limit = Number(value());
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("--limit needs a whole number");
      options.limit = limit;
    } else if (arg === "--wait") {
      const seconds = Number(value());
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) {
        throw new Error(`--wait needs seconds from 0 to ${MAX_WAIT_SECONDS}`);
      }
      options.waitSeconds = seconds;
      waitGiven = true;
    } else if (arg === "--follow") options.follow = true;
    else if (arg === "--full") options.full = true;
    else if (arg.startsWith("@")) options.handle = arg.slice(1);
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (options.ref === undefined) options.ref = arg;
    else throw new Error(`one run at a time: ${options.ref} and ${arg}`);
  }
  if (options.follow && waitGiven) throw new Error("--follow and --wait do not go together");
  if (options.handle && (waitGiven || options.follow)) {
    throw new Error("@<handle> reads one event; it takes no --wait or --follow");
  }
  if (options.full && !options.handle) {
    throw new Error("--full prints one event: name it, @<handle>");
  }
  return options;
}

/** Reads one run again and again from one cursor, keeping its files found between reads. */
class Reader {
  readonly #files: FileCache = new Map();
  constructor(
    public status: RunStatus,
    readonly from: Cursor | undefined,
    readonly clock: LogsClock,
    /** Lines of each native file one read takes: about what a page shows. */
    readonly lines: number,
    /** Keeps each activity's native text. */
    readonly full: boolean,
  ) {}

  next(cursor = this.from) {
    return readRun(this.status.run.dir, this.status.run.record.cwd, cursor, {
      ended: this.status.state !== "running",
      files: this.#files,
      now: this.clock.now(),
      lines: this.lines,
      ...(this.full ? { full: true } : {}),
      ...(cursor ? {} : { tail: true }),
    });
  }

  async refresh(runRoot: string): Promise<RunStatus> {
    this.status = (await findRun(runRoot, this.status.ref)).status;
    return this.status;
  }
}

type Read = Awaited<ReturnType<Reader["next"]>>;

/** Each operation's stage and agent, from the lines that name them. */
type Places = { stage: Map<string, string>; agent: Map<string, string> };

function operationPlaces(lines: readonly { line: RunLogLine }[]): Places {
  const places: Places = { stage: new Map(), agent: new Map() };
  for (const { line } of lines) {
    if (!("operationId" in line) || !line.operationId) continue;
    if ("stage" in line && line.stage) places.stage.set(line.operationId, line.stage);
    if ("agent" in line && line.agent) places.agent.set(line.operationId, line.agent);
  }
  return places;
}

function agentOf(event: ReadEvent, places: Places): string | undefined {
  if (event.source === "activity") return event.agent;
  if ("agent" in event.line && event.line.agent) return event.line.agent;
  // A session a headless turn named names its operation, and so its agent.
  return "operationId" in event.line && event.line.operationId
    ? places.agent.get(event.line.operationId)
    : undefined;
}

function stageOf(event: ReadEvent, places: Places): string | undefined {
  if (event.source === "activity") {
    return event.operation ? places.stage.get(event.operation) : undefined;
  }
  return "stage" in event.line ? event.line.stage : undefined;
}

/** The agents a messaging line is between, so `--agent` follows it from either side. */
function sidesOf(event: ReadEvent): readonly string[] {
  if (event.source === "activity") return [];
  const { line } = event;
  switch (line.kind) {
    case "route-opened":
    case "route-closed":
      return line.between ?? [line.from, line.to];
    case "message-sent":
    case "message-refused":
    case "message-delivery":
    case "message-undelivered":
      return [line.from, line.to];
    case "request-ended":
      return [line.owedBy, line.asker];
    default:
      return [];
  }
}

function kept(read: Read, options: LogsOptions) {
  const stages = operationPlaces(read.log.lines);
  const events = read.events.filter(
    (event) =>
      (options.agent === undefined ||
        agentOf(event, stages) === options.agent ||
        sidesOf(event).includes(options.agent)) &&
      (options.stage === undefined || stageOf(event, stages) === options.stage),
  );
  return { events, stages };
}

function sameLine(a: ReadEvent, b: ReadEvent): boolean {
  const first = decodeHandle(a.handle);
  const second = decodeHandle(b.handle);
  return (
    first?.kind === "activity" &&
    second?.kind === "activity" &&
    first.file === second.file &&
    first.offset === second.offset
  );
}

async function page(
  reader: Reader,
  alsoRunning: string[],
  options: LogsOptions,
  place: ReadPlace,
  json: boolean,
  out: Out,
  clock: LogsClock,
): Promise<number> {
  let read = await reader.next();
  let { events, stages } = kept(read, options);
  const deadline = clock.now() + options.waitSeconds * 1000;
  let waited = false;
  // Without a cursor, a wait reads on from its first read: nothing before it is kept.
  let from = reader.from;
  // Waits while there is nothing it keeps to show and the run goes on.
  while (
    events.length === 0 &&
    !read.more &&
    reader.status.state === "running" &&
    clock.now() < deadline
  ) {
    waited = true;
    if (!reader.from) from = read.cursor;
    await clock.sleep(POLL_MS);
    await reader.refresh(place.runRoot);
    read = await reader.next(from);
    ({ events, stages } = kept(read, options));
    if (events.length > 0) {
      // A burst comes back as one page.
      await clock.sleep(SETTLE_MS);
      read = await reader.next(from);
      ({ events, stages } = kept(read, options));
    }
  }
  const status = reader.status;

  // Without a cursor the newest `limit`; with one, the oldest `limit` after it.
  let shown: ReadEvent[];
  let cursor = read.cursor;
  let older = false;
  let newer = false;
  if (!reader.from) {
    shown = events.slice(-options.limit);
    older = events.length > shown.length || read.cut;
  } else {
    let end = Math.min(options.limit, events.length);
    // A line's items stay together.
    while (end < events.length && sameLine(events[end - 1]!, events[end]!)) end += 1;
    shown = events.slice(0, end);
    newer = end < events.length || read.more;
    if (end < events.length) {
      cursor = cutCursor(read.events, read.events.indexOf(events[end]!), read.cursor);
    }
  }
  const stage = currentStage(status, read.log.lines);
  const filters = [
    ...(options.agent ? ["--agent", options.agent] : []),
    ...(options.stage ? ["--stage", options.stage] : []),
  ];
  // A run that ended has a next only while its page stopped before the newest event.
  const running = status.state === "running";
  const next =
    running || newer ? nextLogs(status, place, cursor, filters, running && !newer) : undefined;
  if (json) {
    const { started, ended } = span(status, clock.now());
    const document: LogsJson = {
      v: 1,
      run: {
        ref: status.ref,
        state: status.state,
        checked: status.checked,
        ...(stage ? { stage } : {}),
        ambiguous: alsoRunning.length > 0,
        ...(status.state !== "running" && ended !== undefined ? { duration: ended - started } : {}),
      },
      events: shown.map((event) => publish(event, stages, PAGE_TEXT)),
      cursor: encodeCursor(cursor),
      more: { ...(older ? { older: true } : {}), ...(newer ? { newer: true } : {}) },
      ...(next ? { next } : {}),
    };
    out.stdout(JSON.stringify(document, null, 2));
    return 0;
  }
  const lastAt = read.log.lines.at(-1);
  const lines: string[] = [
    header(status, stage, lastAt ? Date.parse(timeOf(lastAt.line)) : undefined),
  ];
  if (alsoRunning.length > 0) {
    const count = alsoRunning.length + (status.state === "running" ? 1 : 0);
    lines.push(`note: ${count} runs running; also ${alsoRunning.join(", ")}`);
  }
  if (older) {
    const of = options.agent ? ` for ${options.agent}` : "";
    // A cut read has more than any --limit reaches: paging from the start reads it all.
    const more = read.cut
      ? `from the start: ${shellLine([...command(place, "awf", "logs", status.ref), ...filters, "--after", encodeCursor({ log: 0, files: {} })])}`
      : "raise --limit for more";
    const total = read.cut ? `the last ${events.length} read` : `${events.length}`;
    lines.push(`(showing ${shown.length} of ${total}${of}; ${more})`);
  }
  lines.push(...shown.map((event) => describeEvent(event, stages)));
  lines.push(
    trailer(
      status,
      read,
      place,
      next,
      stage,
      waited && shown.length === 0 ? options.waitSeconds : undefined,
    ),
  );
  out.stdout(lines.join("\n"));
  return 0;
}

async function follow(
  reader: Reader,
  options: LogsOptions,
  place: ReadPlace,
  out: Out,
  clock: LogsClock,
): Promise<number> {
  let cursor = reader.from;
  let read = await reader.next(cursor);
  out.stdout(header(reader.status, currentStage(reader.status, read.log.lines)));
  for (let first = true; ; first = false) {
    const { events, stages } = kept(read, options);
    // Without a cursor it starts from the last `--limit`, as a page would.
    const shown = first && !reader.from ? events.slice(-options.limit) : events;
    for (const event of shown) out.stdout(describeEvent(event, stages));
    cursor = read.cursor;
    // A read that stopped short goes on at once.
    if (!read.more) {
      if (reader.status.state !== "running") break;
      await clock.sleep(POLL_MS);
    }
    await reader.refresh(place.runRoot);
    read = await reader.next(cursor);
  }
  out.stdout(trailer(reader.status, read, place, undefined, undefined, undefined));
  return 0;
}

async function oneEvent(
  status: RunStatus,
  options: LogsOptions,
  json: boolean,
  out: Out,
  again: string,
): Promise<number> {
  const missing = new DoesNotFit(
    `@${options.handle} is no event of ${status.ref}; see its events: ${again}`,
  );
  const handle = decodeHandle(options.handle!);
  if (!handle) throw missing;
  // Read from where the handle points, and only its file.
  const read = await readRun(
    status.run.dir,
    status.run.record.cwd,
    handle.kind === "event"
      ? { log: handle.line - 1, files: {} }
      : { log: Number.MAX_SAFE_INTEGER, files: { [handle.file]: handle.offset } },
    {
      ended: status.state !== "running",
      full: options.full || json,
      only: handle.kind === "event" ? "" : handle.file,
    },
  );
  const stages = operationPlaces(read.log.lines);
  const event = read.events.find((each) => each.handle === encodeHandle(handle));
  if (!event) throw missing;
  if (json) {
    const document: LogsJson = {
      v: 1,
      run: { ref: status.ref, state: status.state, checked: status.checked },
      events: [publish(event, stages)],
    };
    out.stdout(JSON.stringify(document, null, 2));
    return 0;
  }
  const lines = [describeEvent(event, stages)];
  if (options.full) {
    lines.unshift(
      `(${event.source === "activity" ? "native text" : "the log's line"}; common credential shapes are masked)`,
    );
    const text =
      event.source === "activity" ? event.text : JSON.stringify(masked(event.line), null, 2);
    if (text) lines.push(...text.split("\n").map((line) => `  ${line}`));
  }
  out.stdout(lines.join("\n"));
  return 0;
}

function header(status: RunStatus, stage: string | undefined, lastEventAt?: number): string {
  return [status.ref, stateWord(status, lastEventAt), ...(stage ? [`stage ${stage}`] : [])].join(
    "  ",
  );
}

function trailer(
  status: RunStatus,
  read: Read,
  place: ReadPlace,
  next: string[] | undefined,
  stage: string | undefined,
  nothingIn: number | undefined,
): string {
  if (status.state === "running") {
    const said = `next: ${shellLine(next ?? command(place, "awf", "logs", status.ref))}`;
    if (nothingIn === undefined) return said;
    return `nothing new in ${nothingIn}s · running${stage ? `, stage ${stage}` : ""} · ${said}`;
  }
  if (next) return `next: ${shellLine(next)} · run ${status.state}, more to read`;
  if (status.state === "interrupted") {
    const go = continueOf(status, read.log.lines, place);
    return `run interrupted${go ? ` · continue: ${go}` : ""}`;
  }
  const { ended, started } = span(status, Date.now());
  const took = ended === undefined ? "" : ` in ${duration(ended - started)}`;
  return `run ended: ${status.state}${took} · result: ${shellLine(command(place, "awf", "runs", status.ref))}`;
}

/** An event as `--json` publishes it: the line's own fields, or the activity, with its keys. */
function publish(event: ReadEvent, stages: Places, limit = Number.POSITIVE_INFINITY): LogEventJson {
  if (event.source === "activity") {
    const stage = event.operation ? stages.stage.get(event.operation) : undefined;
    return {
      handle: event.handle,
      at: event.at,
      kind: "activity",
      operation: event.operation,
      ...(event.agent ? { agent: event.agent } : {}),
      ...(stage ? { stage } : {}),
      activity: event.activity,
      ...(event.text === undefined ? {} : { text: masked(event.text, limit) as string }),
    };
  }
  const { version: _version, ...fields } = event.line;
  return {
    handle: event.handle,
    at: event.at,
    ...(masked(fields, limit) as typeof fields),
    ...("operationId" in fields ? { operation: fields.operationId } : {}),
  };
}

/** `@e216 09:27:02 fix  fixer  turn ended  answered  1m48s`. */
function describeEvent(event: ReadEvent, stages: Places): string {
  const agent = agentOf(event, stages);
  const where = [stageOf(event, stages), agent && said(agent, 60)].filter(Boolean).join("  ");
  const what =
    event.source === "activity" ? describeActivity(event.activity) : describeLine(event.line);
  return `@${event.handle} ${clockTime(event.at)} ${where ? `${where}  ` : ""}${what}`;
}

function describeLine(line: RunLogLine): string {
  const operation = (of: "turn" | "compact") => (of === "compact" ? "compaction" : "turn");
  switch (line.kind) {
    case "attempt-started":
      return `attempt ${line.attempt} started`;
    case "attempt-ended":
      return `attempt ${line.attempt} ended  ${line.outcome}`;
    case "stage-started":
      return "stage started";
    case "stage-ended":
      return `stage ${line.source ?? "ended"}  ${line.outcome}`;
    case "operation-started":
      return `${operation(line.of)} started${line.label ? `  label "${said(line.label)}"` : ""}`;
    case "operation-failed":
      return `${operation(line.of)} failed  ${said(line.error)}`;
    case "turn":
    case "compact": {
      const took =
        line.deliveredAt && line.settledAt
          ? `  ${duration(Date.parse(line.settledAt) - Date.parse(line.deliveredAt))}`
          : "";
      return `${operation(line.kind)} ended  ${line.outcome}${took}`;
    }
    case "session-known":
      return `session ${line.session.harness} ${line.session.id}`;
    case "agent-opened":
      return `opened  ${line.harness}${line.caller ? "  (the calling session)" : ""}`;
    case "agent-stopped":
      return "stopped";
    case "agent-forked":
      return `forked from ${line.from ? said(line.from, 60) : "the calling session"}`;
    case "log":
      return said(line.text);
    case "warning":
      return `warning: ${said(line.text)}`;
    case "decision-asked":
      return `decision "${said(line.key)}" asked  ${line.model}`;
    case "decision-ended":
      return `decision ${line.decision} ${line.outcome}${line.error ? `  ${said(line.error)}` : ""}`;
    case "route-opened":
      return `route ${routeEnds(line)} opened  "${said(line.purpose)}"  ${line.maxMessages} messages${
        line.timeoutMs === undefined ? "" : `, a question closes after ${duration(line.timeoutMs)}`
      }`;
    case "route-closed":
      return `route ${routeEnds(line)} closed  ${line.reason}`;
    case "message-sent":
      return `message ${line.message} ${said(line.from, 60)} → ${said(line.to, 60)}  ${line.bytes} B${
        line.via === undefined ? "" : ` via ${line.via}`
      }${line.replyTo === undefined ? "" : `, reply to ${line.replyTo}`}${
        line.awaitsReply
          ? `, reply owed  ${said(line.from, 60)} awaits it${
              line.awaitsReply.until
                ? ` until ${clockTime(Date.parse(line.awaitsReply.until))}`
                : ""
            }`
          : ""
      }`;
    case "message-refused":
      return `${line.command} ${said(line.from, 60)} → ${said(line.to, 60)} refused  ${line.code}`;
    case "message-delivery":
      return `message ${line.message} ${line.state}`;
    case "message-undelivered":
      return `message ${line.message} undelivered  ${line.reason}`;
    case "request-ended":
      return `request ${line.message} ${line.end}${line.reason ? `  ${said(line.reason)}` : ""}`;
    case "participant-connected":
      return `${said(line.participant, 60)} connected${line.to === "code" ? " to the code" : ""}`;
    case "participant-post":
      return `run → ${said(line.participant, 60)}  ${said(line.text)}`;
  }
}

function routeEnds(line: RouteEnds): string {
  return line.between
    ? `${said(line.between[0], 60)} ↔ ${said(line.between[1], 60)}`
    : `${said(line.from, 60)} → ${said(line.to, 60)}`;
}
