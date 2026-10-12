import type { RunLogLine } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import {
  clockTime,
  command,
  continueOf,
  currentStage,
  failed,
  nextLogs,
  type Out,
  parsePlace,
  type ReadPlace,
  span,
  stateWord,
} from "./run-commands";
import {
  type Cursor,
  decodeCursor,
  decodeHandle,
  encodeCursor,
  type FileCache,
  type ReadEvent,
  readRun,
  timeOf,
} from "./run-read";
import { findRun, type RunStatus } from "./run-state";
import { describeActivity, duration } from "./run-view";

export const logsUsage = [
  "usage: awf logs [<run>] [@<handle>] [--agent <key>] [--stage <name>] [--after <cursor>]",
  "                [--limit <n>] [--wait <seconds> | --follow] [--full] [--cwd <directory>]",
  "                [--run-root <directory>] [--json]",
  "",
  "What a run did and is doing: its events and what its agents did, read from their own session",
  "files, merged by time. With no run, the newest here. Without --after, the last 40 events; with",
  "it, what came after, oldest first. Every answer ends with the command that gets only what is",
  "new. --wait returns on the first new event or after that many seconds, at most 300; --follow",
  "prints each event as it comes until the run ends. @<handle> names one event, and --full prints",
  "its text, with common credential shapes masked.",
  "",
  "Exits 0 on any read that worked, 1 when there is no such run or the cursor or handle does not",
  "fit it, 2 on a usage error, 3 when the run's files could not be read.",
].join("\n");

const DEFAULT_LIMIT = 40;
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
    const again = command(place, "awf", "logs", status.ref).join(" ");
    let after: Cursor | undefined;
    if (options.after !== undefined) {
      after = decodeCursor(options.after);
      if (!after)
        throw new DoesNotFit(
          `cursor ${options.after} does not fit this run; start again: ${again}`,
        );
    }
    const read = new Reader(status, after);
    if (after && after.log > (await read.next()).log.lines.length) {
      throw new DoesNotFit(`cursor ${options.after} does not fit this run; start again: ${again}`);
    }
    if (options.handle !== undefined) {
      return await oneEvent(status, options, json, out, again);
    }
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
  if (options.full && !options.handle) {
    throw new Error("--full prints one event: name it, @<handle>");
  }
  return options;
}

/** Reads one run again and again from one cursor, keeping its files found between reads. */
class Reader {
  readonly #files: FileCache = { lines: -1, sessions: new Map() };
  constructor(
    public status: RunStatus,
    readonly from: Cursor | undefined,
  ) {}

  next(cursor = this.from) {
    return readRun(this.status.run.dir, this.status.run.record.cwd, cursor, {
      ended: this.status.state !== "running",
      files: this.#files,
    });
  }

  async refresh(runRoot: string): Promise<RunStatus> {
    this.status = (await findRun(runRoot, this.status.ref)).status;
    return this.status;
  }
}

type Read = Awaited<ReturnType<Reader["next"]>>;

/** Each operation's stage, from the lines that name it. */
function operationStages(lines: readonly { line: RunLogLine }[]): Map<string, string> {
  const stages = new Map<string, string>();
  for (const { line } of lines) {
    if ("operationId" in line && "stage" in line && line.stage) {
      stages.set(line.operationId, line.stage);
    }
  }
  return stages;
}

function agentOf(event: ReadEvent): string | undefined {
  if (event.source === "activity") return event.agent;
  return "agent" in event.line ? event.line.agent : undefined;
}

function stageOf(event: ReadEvent, stages: Map<string, string>): string | undefined {
  if (event.source === "activity") return event.operation ? stages.get(event.operation) : undefined;
  return "stage" in event.line ? event.line.stage : undefined;
}

function kept(read: Read, options: LogsOptions) {
  const stages = operationStages(read.log.lines);
  const events = read.events.filter(
    (event) =>
      (options.agent === undefined || agentOf(event) === options.agent) &&
      (options.stage === undefined || stageOf(event, stages) === options.stage),
  );
  return { events, stages };
}

/**
 * Where a page cut before `cut` leaves off: before every event it did not show. Events are in
 * time order and the log's lines in line order among them, so nothing shown is read again.
 */
function cutCursor(all: readonly ReadEvent[], cut: number, end: Cursor): Cursor {
  const next: Cursor = { log: end.log, files: { ...end.files } };
  for (const event of all.slice(cut)) {
    const handle = decodeHandle(event.handle)!;
    if (handle.kind === "event") next.log = Math.min(next.log, handle.line - 1);
    else
      next.files[handle.file] = Math.min(next.files[handle.file] ?? handle.offset, handle.offset);
  }
  return next;
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
  // Waits while nothing it keeps is new and the run goes on.
  while (
    events.length === 0 &&
    reader.from &&
    reader.status.state === "running" &&
    clock.now() < deadline
  ) {
    waited = true;
    await clock.sleep(POLL_MS);
    await reader.refresh(place.runRoot);
    read = await reader.next();
    ({ events, stages } = kept(read, options));
    if (events.length > 0) {
      // A burst comes back as one page.
      await clock.sleep(SETTLE_MS);
      read = await reader.next();
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
    older = events.length > shown.length;
  } else {
    let end = Math.min(options.limit, events.length);
    // A line's items stay together.
    while (end < events.length && sameLine(events[end - 1]!, events[end]!)) end += 1;
    shown = events.slice(0, end);
    newer = end < events.length;
    if (newer) cursor = cutCursor(read.events, read.events.indexOf(events[end]!), read.cursor);
  }
  const stage = currentStage(status, read.log.lines);
  const filters = [
    ...(options.agent ? ["--agent", options.agent] : []),
    ...(options.stage ? ["--stage", options.stage] : []),
  ];
  const next =
    status.state === "running" ? nextLogs(status, place, cursor, filters, !newer) : undefined;
  if (json) {
    const { started, ended } = span(status, clock.now());
    out.stdout(
      JSON.stringify(
        {
          v: 1,
          run: {
            ref: status.ref,
            state: status.state,
            checked: status.checked,
            ...(stage ? { stage } : {}),
            ambiguous: alsoRunning.length > 0,
            ...(status.state !== "running" && ended !== undefined
              ? { duration: ended - started }
              : {}),
          },
          events: shown.map((event) => publish(event, stages)),
          cursor: encodeCursor(cursor),
          more: { ...(older ? { older: true } : {}), ...(newer ? { newer: true } : {}) },
          ...(next ? { next } : {}),
        },
        null,
        2,
      ),
    );
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
    lines.push(`(showing ${shown.length} of ${events.length}${of}; raise --limit for more)`);
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
  for (;;) {
    const { events, stages } = kept(read, options);
    for (const event of events) out.stdout(describeEvent(event, stages));
    cursor = read.cursor;
    if (reader.status.state !== "running") break;
    await clock.sleep(POLL_MS);
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
  const read = await readRun(status.run.dir, status.run.record.cwd, undefined, {
    ended: status.state !== "running",
    full: options.full,
  });
  const stages = operationStages(read.log.lines);
  const event = read.events.find((each) => each.handle === options.handle);
  if (!event)
    throw new DoesNotFit(
      `@${options.handle} is no event of ${status.ref}; see its events: ${again}`,
    );
  if (json) {
    const run = { ref: status.ref, state: status.state, checked: status.checked };
    out.stdout(JSON.stringify({ v: 1, run, events: [publish(event, stages)] }, null, 2));
    return 0;
  }
  const lines = [describeEvent(event, stages)];
  if (options.full) {
    if (event.source === "activity")
      lines.unshift("(native text; common credential shapes are masked)");
    const text = event.source === "activity" ? event.text : JSON.stringify(event.line, null, 2);
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
    const said = `next: ${(next ?? command(place, "awf", "logs", status.ref)).join(" ")}`;
    if (nothingIn === undefined) return said;
    return `nothing new in ${nothingIn}s · running${stage ? `, stage ${stage}` : ""} · ${said}`;
  }
  if (status.state === "interrupted") {
    const go = continueOf(status, read.log.lines, place);
    return `run interrupted${go ? ` · continue: ${go}` : ""}`;
  }
  const { ended, started } = span(status, Date.now());
  const took = ended === undefined ? "" : ` in ${duration(ended - started)}`;
  return `run ended: ${status.state}${took} · result: ${command(place, "awf", "runs", status.ref).join(" ")}`;
}

/** An event as `--json` publishes it: the line's own fields, or the activity, with its keys. */
function publish(event: ReadEvent, stages: Map<string, string>) {
  if (event.source === "activity") {
    const stage = event.operation ? stages.get(event.operation) : undefined;
    return {
      handle: event.handle,
      at: event.at,
      kind: "activity",
      operation: event.operation,
      ...(event.agent ? { agent: event.agent } : {}),
      ...(stage ? { stage } : {}),
      activity: event.activity,
      ...(event.text === undefined ? {} : { text: event.text }),
    };
  }
  const { version: _version, ...fields } = event.line;
  return {
    handle: event.handle,
    at: event.at,
    ...fields,
    ...("operationId" in fields ? { operation: fields.operationId } : {}),
  };
}

/** `@e216 09:27:02 fix  fixer  turn ended  answered  1m48s`. */
function describeEvent(event: ReadEvent, stages: Map<string, string>): string {
  const where = [stageOf(event, stages), agentOf(event)].filter(Boolean).join("  ");
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
      return `${operation(line.of)} started${line.label ? `  label "${line.label}"` : ""}`;
    case "operation-failed":
      return `${operation(line.of)} failed  ${line.error}`;
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
      return `forked from ${line.from ?? "the calling session"}`;
    case "log":
      return line.text;
    case "warning":
      return `warning: ${line.text}`;
    case "decision-asked":
      return `decision "${line.key}" asked  ${line.model}`;
    case "decision-ended":
      return `decision ${line.decision} ${line.outcome}`;
  }
}
