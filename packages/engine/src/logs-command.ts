import { homedir } from "node:os";
import type { LogEventJson, LogsJson, RouteEnds, RunLogLine } from "@agentswf/contract/records";
import type { JsonObject } from "@agentswf/contract/workflow";
import { formatDuration, parseWait } from "./duration";
import { messageOf } from "./errors";
import { exists } from "./files";
import help from "./help/logs.txt" with { type: "text" };
import { screenFile } from "./ops";
import { asksJson, printRefusal, refusalLine } from "./refusals";
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
  START,
  timeOf,
} from "./run-read";
import { checkRunEngine, findRun, findRunByRef, type RunStatus } from "./run-state";
import { describeActivity } from "./run-view";

export const logsUsage = help.trimEnd();

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
  home: string = homedir(),
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
    options = parseLogs(parsed.rest, (line) => out.stderr(line));
    if (options.follow && json) throw new Error("--follow is for reading; --json takes --wait");
  } catch (error) {
    printRefusal(out, { json: asksJson(argv), v: 1 }, error, "usage", logsUsage);
    return 2;
  }
  try {
    const { status, alsoRunning } =
      options.ref === undefined
        ? await findRun(place.runRoot, undefined)
        : { status: await findRunByRef(options.ref, place, home), alsoRunning: [] };
    await checkRunEngine(status, home);
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
    if (after) {
      const { log } = await read.next();
      const past = after.run > log.runLines && log.unreadSessions === undefined;
      if (after.log > (log.lines.at(-1)?.number ?? 0) || past) {
        throw new DoesNotFit(
          `cursor ${options.after} does not fit this run; start again: ${again}`,
        );
      }
    }
    if (options.handle !== undefined) return await oneEvent(status, options, json, out, again);
    if (options.follow) return await follow(read, options, place, out, clock);
    return await page(read, alsoRunning, options, place, json, out, clock);
  } catch (error) {
    if (error instanceof DoesNotFit) {
      if (json) out.stdout(refusalLine(1, "cursor", error.message));
      out.stderr(error.message);
      return 1;
    }
    return failed(error, place, out, messageOf(error), { json, v: 1 });
  }
}

function parseLogs(rest: readonly string[], deprecated: (line: string) => void): LogsOptions {
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
      options.waitSeconds = parseWait(value(), MAX_WAIT_SECONDS, deprecated);
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

  /** The run read again where it was found, which may be another project's. */
  async refresh(): Promise<RunStatus> {
    this.status = (await findRun(this.status.run.root, this.status.ref)).status;
    return this.status;
  }
}

type Read = Awaited<ReturnType<Reader["next"]>>;

/** Where each operation ran, and each tool call's input, by its id, so its end shows it. */
type Places = {
  stage: Map<string, string>;
  agent: Map<string, string>;
  calls: Map<string, { input: JsonObject; ended: boolean }>;
};

function operationPlaces(lines: readonly { line: RunLogLine }[]): Places {
  const places: Places = { stage: new Map(), agent: new Map(), calls: new Map() };
  for (const { line } of lines) {
    if (line.kind === "tool-called")
      places.calls.set(line.call, { input: line.input, ended: false });
    if (line.kind === "tool-ended") {
      const call = places.calls.get(line.call);
      if (call) call.ended = true;
    }
    if (!("operationId" in line) || !line.operationId) continue;
    if ("stage" in line && line.stage) places.stage.set(line.operationId, line.stage);
    if ("agent" in line && line.agent) places.agent.set(line.operationId, line.agent);
  }
  return places;
}

function agentOf(event: ReadEvent, places: Places): string | undefined {
  if (event.source === "activity") return event.agent;
  if (event.source === "run") return event.line.agent;
  if ("agent" in event.line && event.line.agent) return event.line.agent;
  // A line that names only its operation, such as a message's delivery, is its operation's agent's.
  return "operationId" in event.line && event.line.operationId
    ? places.agent.get(event.line.operationId)
    : undefined;
}

function stageOf(event: ReadEvent, places: Places): string | undefined {
  if (event.source === "activity") {
    return event.operation ? places.stage.get(event.operation) : undefined;
  }
  if (event.source === "run") {
    return event.line.operation ? places.stage.get(event.line.operation) : undefined;
  }
  return "stage" in event.line ? event.line.stage : undefined;
}

/** The agents a messaging line is between, so `--agent` follows it from either side. */
function sidesOf(event: ReadEvent): readonly string[] {
  if (event.source !== "log") return [];
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

/**
 * The `run.jsonl` lines text leaves out: an agent's first session, which its opening and first turn
 * already stand for, unless it is a fork's, made apart from any turn.
 */
function quietSessions(read: Read): Set<number> {
  const forked = new Set<string>();
  for (const { line } of read.log.lines) if (line.kind === "agent-forked") forked.add(line.agent);
  const quiet = new Set<number>();
  const seen = new Set<string>();
  for (const { number, line } of read.log.named) {
    if (!seen.has(line.agent) && !forked.has(line.agent)) quiet.add(number);
    seen.add(line.agent);
  }
  return quiet;
}

function kept(read: Read, options: LogsOptions, json = false) {
  const stages = operationPlaces(read.log.lines);
  const quiet = json ? new Set<number>() : quietSessions(read);
  const events = read.events.filter(
    (event) =>
      !(event.source === "run" && quiet.has(decodeHandleLine(event.handle))) &&
      // A call that has ended shows on its end's line, with its input; `--json` keeps both.
      !(
        !json &&
        event.source === "log" &&
        event.line.kind === "tool-called" &&
        stages.calls.get(event.line.call)?.ended
      ) &&
      (options.agent === undefined ||
        agentOf(event, stages) === options.agent ||
        sidesOf(event).includes(options.agent)) &&
      (options.stage === undefined || stageOf(event, stages) === options.stage),
  );
  return { events, stages };
}

function decodeHandleLine(handle: string): number {
  const decoded = decodeHandle(handle);
  return decoded?.kind === "run" ? decoded.line : 0;
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
  let { events, stages } = kept(read, options, json);
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
    await reader.refresh();
    read = await reader.next(from);
    ({ events, stages } = kept(read, options, json));
    if (events.length > 0) {
      // A burst comes back as one page.
      await clock.sleep(SETTLE_MS);
      read = await reader.next(from);
      ({ events, stages } = kept(read, options, json));
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
  const screens = await keptScreens(status.run.dir, shown);
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
      events: shown.map((event) => publish(event, stages, screens, PAGE_TEXT)),
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
  if (read.log.unreadSessions !== undefined) {
    lines.push(
      `note: run.jsonl could not be read, so no agent's activity shows: ${said(read.log.unreadSessions)}`,
    );
  }
  if (alsoRunning.length > 0) {
    const count = alsoRunning.length + (status.state === "running" ? 1 : 0);
    lines.push(`note: ${count} runs running; also ${alsoRunning.join(", ")}`);
  }
  if (older) {
    const of = options.agent ? ` for ${options.agent}` : "";
    // A cut read has more than any --limit reaches: paging from the start reads it all.
    const more = read.cut
      ? `from the start: ${shellLine([...command(place, "awf", "logs", status.ref), ...filters, "--after", encodeCursor(START)])}`
      : "raise --limit for more";
    const total = read.cut ? `the last ${events.length} read` : `${events.length}`;
    lines.push(`(showing ${shown.length} of ${total}${of}; ${more})`);
  }
  lines.push(...shown.map((event) => describeEvent(event, stages, screens)));
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
    const screens = await keptScreens(reader.status.run.dir, shown);
    for (const event of shown) out.stdout(describeEvent(event, stages, screens));
    cursor = read.cursor;
    // A read that stopped short goes on at once.
    if (!read.more) {
      if (reader.status.state !== "running") break;
      await clock.sleep(POLL_MS);
    }
    await reader.refresh();
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
  const none = Number.MAX_SAFE_INTEGER;
  const read = await readRun(
    status.run.dir,
    status.run.record.cwd,
    handle.kind === "event"
      ? { log: handle.line - 1, run: none, files: {} }
      : handle.kind === "run"
        ? { log: none, run: handle.line - 1, files: {} }
        : { log: none, run: none, files: { [handle.file]: handle.offset } },
    {
      ended: status.state !== "running",
      full: options.full || json,
      only: handle.kind === "activity" ? handle.file : "",
    },
  );
  const stages = operationPlaces(read.log.lines);
  const event = read.events.find((each) => each.handle === encodeHandle(handle));
  if (!event) throw missing;
  const screens = await keptScreens(status.run.dir, [event]);
  if (json) {
    const document: LogsJson = {
      v: 1,
      run: { ref: status.ref, state: status.state, checked: status.checked },
      events: [publish(event, stages, screens)],
    };
    out.stdout(JSON.stringify(document, null, 2));
    return 0;
  }
  const lines = [describeEvent(event, stages, screens)];
  if (options.full) {
    lines.unshift(
      `(${{ activity: "native text", log: "the log's line", run: "run.jsonl's line" }[event.source]}; common credential shapes are masked)`,
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
  const took = ended === undefined ? "" : ` in ${formatDuration(ended - started)}`;
  return `run ended: ${status.state}${took} · result: ${shellLine(command(place, "awf", "runs", status.ref))}`;
}

/** An event as `--json` publishes it: the line's own fields, or the activity, with its keys. */
function publish(
  event: ReadEvent,
  stages: Places,
  screens: Screens,
  limit = Number.POSITIVE_INFINITY,
): LogEventJson {
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
  if (event.source === "run") {
    return { handle: event.handle, ...(masked(event.line, limit) as typeof event.line) };
  }
  const { version: _version, ...fields } = event.line;
  return {
    handle: event.handle,
    at: event.at,
    ...(masked(fields, limit) as typeof fields),
    ...("operationId" in fields ? { operation: fields.operationId } : {}),
    ...screenOf(event, screens),
  };
}

/** The screens kept for the operations of the events shown, by operation id. */
type Screens = ReadonlyMap<string, string>;

/** A turn or compaction that ended without an answer, and the file its screen would be kept in. */
function screenOf(event: ReadEvent, screens: Screens): { screen?: string } {
  if (event.source !== "log") return {};
  const { line } = event;
  if (line.kind !== "turn" && line.kind !== "compact") return {};
  const screen = screens.get(line.operationId);
  return screen ? { screen } : {};
}

async function keptScreens(runDir: string, events: readonly ReadEvent[]): Promise<Screens> {
  const screens = new Map<string, string>();
  await Promise.all(
    events.map(async (event) => {
      if (event.source !== "log") return;
      const { line } = event;
      if (line.kind !== "turn" && line.kind !== "compact") return;
      if (line.outcome === "answered" || line.outcome === "cancelled") return;
      const file = screenFile(runDir, line.operationId);
      if (await exists(file)) screens.set(line.operationId, file);
    }),
  );
  return screens;
}

/** `@e216 09:27:02 fix  fixer  turn ended  answered  1m48s`. */
function describeEvent(event: ReadEvent, stages: Places, screens: Screens): string {
  const agent = agentOf(event, stages);
  const where = [stageOf(event, stages), agent && said(agent, 60)].filter(Boolean).join("  ");
  const what =
    event.source === "activity"
      ? describeActivity(event.activity)
      : event.source === "run"
        ? `session ${event.line.harness} ${event.line.session}`
        : describeLine(event.line, stages);
  const { screen } = screenOf(event, screens);
  return `@${event.handle} ${clockTime(event.at)} ${where ? `${where}  ` : ""}${what}${
    screen ? `  screen: ${screen}` : ""
  }`;
}

function describeLine(line: RunLogLine, places: Places): string {
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
          ? `  ${formatDuration(Date.parse(line.settledAt) - Date.parse(line.deliveredAt))}`
          : "";
      return `${operation(line.kind)} ended  ${line.outcome}${took}`;
    }
    case "sandbox-opened":
      return `sandbox ${said(line.key, 60)} opened  ${line.provider}`;
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
        line.timeoutMs === undefined
          ? ""
          : `, a question closes after ${formatDuration(line.timeoutMs)}`
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
    // A call is one line, its end's: what it was given, how it ended, and what it said back.
    // Shown alone only while its end isn't in the log: still running, or cut short by a crash.
    case "tool-called":
      return toolLine(
        line.tool,
        line.input,
        places.calls.get(line.call)?.ended ? "called" : "no end yet",
      );
    case "tool-ended": {
      const answered =
        line.outcome !== "ok"
          ? line.error
          : typeof line.result === "string"
            ? `→ ${line.result}`
            : line.result === undefined
              ? undefined
              : `→ ${JSON.stringify(line.result)}`;
      return toolLine(
        line.tool,
        places.calls.get(line.call)?.input,
        // Most calls take under a second; a duration says something only past one.
        line.durationMs < 1000
          ? line.outcome
          : `${line.outcome}  ${formatDuration(line.durationMs)}`,
        answered,
      );
    }
    case "tool-refused":
      return [
        `tool call ${said(line.tool, 60)}`,
        "refused",
        line.code,
        line.error && said(line.error),
      ]
        .filter(Boolean)
        .join("  ");
  }
}

/** `tool call close_item {"id":"a1"}  ok  → Closed a1.`, apart from the harness's own tools. */
function toolLine(
  tool: string,
  input: JsonObject | undefined,
  how: string,
  answered?: string,
): string {
  const given = input && Object.keys(input).length > 0 ? ` ${said(JSON.stringify(input), 80)}` : "";
  return [`tool call ${said(tool, 60)}${given}`, how, answered && said(answered)]
    .filter(Boolean)
    .join("  ");
}

function routeEnds(line: RouteEnds): string {
  return line.between
    ? `${said(line.between[0], 60)} ↔ ${said(line.between[1], 60)}`
    : `${said(line.from, 60)} → ${said(line.to, 60)}`;
}
