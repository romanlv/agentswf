import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AttemptRecord,
  InboxErrorJson,
  InboxExpiry,
  InboxItemJson,
  RequestEnd,
  RunLogLine,
} from "@agentswf/contract/records";
import type { InboxCode } from "@agentswf/contract/wire";
import type { JsonObject } from "@agentswf/contract/workflow";
import { maskCredentials } from "@agentswf/harness";
import { duration } from "./duration";
import { messageOf } from "./errors";
import { exists } from "./files";
import { readMailbox } from "./mailbox";
import {
  clockTime,
  command,
  failed,
  type Out,
  parsePlace,
  type ReadPlace,
  shellLine,
} from "./run-commands";
import { findRunByRef, listRuns, RunNotFound, statusOf } from "./run-state";
import {
  attemptsToken,
  type LogMark,
  logSize,
  type Run,
  readAttempts,
  readEventsFrom,
} from "./runs";

export const inboxUsage = [
  "usage: awf inbox [<run>] [--open] [--workflow <name>] [--as <key>] [--after <cursor>] [--wait <seconds>]",
  "                 [--cwd <directory>] [--run-root <directory>] [--json]",
  "",
  "What agents said to a participant outside the run, and what it said back: routes, messages,",
  "answers, questions that closed unanswered, and each attempt's end, oldest first. Without a run,",
  "every run here that connected one; --workflow narrows that. A run is <workflow>/<id>, or an <id>",
  "only one workflow has. --after reads on from a cursor the last answer gave; --wait",
  "waits up to that many seconds, at most 300, when nothing is new. --open lists the questions",
  "still waiting for an answer, a snapshot. --json prints one item per line.",
  "",
  "Exits 0 on a read that worked, 1 when there is no such run, it has no participant, or the",
  "cursor is another's, 2 on a usage error, 3 when the run's files could not be read.",
].join("\n");

const MAX_WAIT_SECONDS = 300;
const POLL_MS = 1_000;

/** The clock and the pause between polls, which tests drive. */
export type InboxClock = { now(): number; sleep(ms: number): Promise<void> };
const REAL_CLOCK: InboxClock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

type Options = {
  ref?: string;
  all: boolean;
  open: boolean;
  workflow?: string;
  as?: string;
  after?: string;
  waitSeconds: number;
};

/** An item's place in its run's log: its line, the attempts ended before it, and its turn among those after the line. */
type Position = [line: number, ended: number, index: number];

type Body<T> = T extends unknown ? Omit<T, "v" | "ref" | "cursor"> : never;
/** An item without what the command adds to it: its run, and the cursor that reads on after it. */
type Item = Body<InboxItemJson> & { position: Position };

/** The cursor: who it was made for, and each run's last position read. */
type CursorState = { f: string; r: Record<string, Position> };

class Refused extends Error {
  constructor(
    readonly code: InboxCode,
    message: string,
  ) {
    super(message);
  }
}

export async function inboxCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  {
    clock = REAL_CLOCK,
    home = homedir(),
    signal,
  }: {
    clock?: InboxClock;
    /** Where `~/.awf/projects` is, through which an event run is found from anywhere. */
    home?: string;
    /** A stop, as a signal to `awf`: a wait ends at the next poll, as at its deadline. */
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.stdout(inboxUsage);
    return 0;
  }
  let place: ReadPlace;
  let json: boolean;
  let options: Options;
  try {
    const parsed = parsePlace(argv, shellCwd);
    place = parsed.place;
    json = parsed.json;
    options = parseInbox(parsed.rest);
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}\n\n${inboxUsage}`);
    return 2;
  }
  const refuse = (code: InboxCode, message: string) => {
    if (json) out.stdout(JSON.stringify({ v: 1, code, error: message } satisfies InboxErrorJson));
    else out.stderr(`awf: ${message}`);
    return 1;
  };
  try {
    const filter = options.all
      ? `all|${options.workflow ?? ""}|${options.as ?? ""}`
      : `run|${options.ref}|${options.as ?? ""}`;
    let state: CursorState = { f: filter, r: {} };
    // Under --all no run is missing or unconnected, so a cursor is checked first, sparing a read.
    let checked = options.after === undefined;
    if (!checked && options.all) {
      const given = decodeCursor(options.after!);
      if (!given || given.f !== filter)
        throw new Refused(
          "bad-cursor",
          `cursor ${options.after} was made with another run or filter; read again without --after`,
        );
      state = given;
      checked = true;
    }
    const deadline = clock.now() + options.waitSeconds * 1000;
    // An event run lives in its project, found through ~/.awf/projects from anywhere (Q15).
    const found =
      options.ref === undefined ? undefined : await findRunByRef(options.ref, place, home);
    const watch = new Watch(found?.run.root ?? place.runRoot, options.as);
    const one = found === undefined ? undefined : watch.entry(found.run);
    for (;;) {
      const runs = await readInbox(options, state, watch, one);
      // After a run that is not there, or never connected one: those come first.
      if (!checked) {
        const given = decodeCursor(options.after!);
        if (!given || given.f !== filter)
          throw new Refused(
            "bad-cursor",
            `cursor ${options.after} was made with another run or filter; read again without --after`,
          );
        state = given;
        checked = true;
        continue;
      }
      if (options.open) {
        const open = openQuestions(runs);
        if (json) for (const item of open) out.stdout(JSON.stringify(item));
        else
          out.stdout(
            open.length
              ? open.map((item) => safe(textOf(item, options.all))).join("\n")
              : "No open questions.",
          );
        return 0;
      }
      const fresh = newItems(runs, state);
      if (fresh.length > 0 || clock.now() >= deadline || signal?.aborted) {
        const lines: string[] = [];
        for (const { ref, item } of fresh) {
          state = { f: filter, r: { ...state.r, [ref]: item.position } };
          const { position: _position, ...shown } = item;
          const published = {
            v: 1,
            ref,
            ...shown,
            cursor: encodeCursor(state),
          } as InboxItemJson;
          lines.push(json ? JSON.stringify(published) : safe(textOf(published, options.all)));
        }
        if (json) {
          for (const line of lines) out.stdout(line);
        } else {
          const words = options.all
            ? ["awf", "inbox", ...(options.workflow ? ["--workflow", options.workflow] : [])]
            : ["awf", "inbox", options.ref!];
          const again = command(
            place,
            ...words,
            ...(options.as ? ["--as", options.as] : []),
            "--after",
            encodeCursor(state),
          );
          out.stdout([...lines, `next: ${shellLine(again)}`].join("\n"));
        }
        return 0;
      }
      await clock.sleep(Math.min(POLL_MS, Math.max(0, deadline - clock.now())));
    }
  } catch (error) {
    if (error instanceof Refused) return refuse(error.code, error.message);
    if (error instanceof RunNotFound) return refuse("not-found", error.message);
    return failed(error, place, out, messageOf(error));
  }
}

function parseInbox(rest: readonly string[]): Options {
  const options: Options = { all: false, open: false, waitSeconds: 0 };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const value = () => {
      const given = rest[index + 1];
      if (given === undefined || given.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return given;
    };
    if (arg === "--open") options.open = true;
    else if (arg === "--workflow") options.workflow = value();
    else if (arg === "--as") options.as = value();
    else if (arg === "--after") options.after = value();
    else if (arg === "--wait") {
      const seconds = Number(value());
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS)
        throw new Error(`--wait needs seconds from 0 to ${MAX_WAIT_SECONDS}`);
      options.waitSeconds = seconds;
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (options.ref === undefined) options.ref = arg;
    else throw new Error(`one run at a time: ${options.ref} and ${arg}`);
  }
  options.all = options.ref === undefined;
  if (options.workflow !== undefined && !options.all)
    throw new Error("--workflow narrows every run here; a run names its workflow already");
  if (options.open && (options.after !== undefined || options.waitSeconds > 0))
    throw new Error("--open is a snapshot: it takes no --after or --wait");
  return options;
}

type RunItems = { ref: string; items: Item[] };

/** The runs to read, each with its items; a run that never connected a participant has none. */
async function readInbox(
  options: Options,
  state: CursorState,
  watch: Watch,
  one: Watched | undefined,
): Promise<RunItems[]> {
  if (one) {
    const ref = `${one.run.record.workflow}/${one.run.record.id}`;
    // Removed while waited on: gone, as it would be to a read started now.
    if (!(await exists(join(one.run.dir, "run.json")))) throw new RunNotFound(`no run ${ref}`);
    await watch.read(one);
    if (one.items === undefined && !one.live)
      throw new Refused(
        "no-participant",
        `${ref} ended without connecting ${options.as ? `participant ${options.as}` : "a participant"}`,
      );
    return [{ ref, items: one.items ?? [] }];
  }
  const found: RunItems[] = [];
  for (const each of await watch.list()) {
    const { workflow, id } = each.run.record;
    if (options.workflow !== undefined && workflow !== options.workflow) continue;
    const ref = `${workflow}/${id}`;
    // One that cannot be read is no reason to fail the others.
    const read = await watch.read(each, state.r[ref]).then(
      () => true,
      () => false,
    );
    if (read && each.items) found.push({ ref, items: each.items });
  }
  return found;
}

/** One run as this command last read it, kept while it waits. */
type Watched = {
  run: Run;
  /** The attempt files when `attempts` was read; undefined before the first read. */
  token?: string;
  attempts: AttemptRecord[];
  /** Each attempt's last wait label, from the mailbox, read with `attempts`. */
  labels: ReadonlyMap<number, string>;
  fold: ItemFold;
  mark: LogMark;
  /** Undefined when it never connected a participant, or none under `as`. */
  items: Item[] | undefined;
  live: boolean;
  /**
   * Its last attempt had ended, or its process was gone, when its log was read: nothing comes
   * until another attempt.
   */
  settled: boolean;
};

/**
 * The runs a command reads, kept while it waits, so a poll reads only what changed since the last:
 * a run's record once, its attempts when their files change, and its log on from where the last
 * read stopped. A settled run is checked for another attempt only.
 */
class Watch {
  #runs = new Map<string, Watched>();

  constructor(
    readonly runRoot: string,
    readonly as: string | undefined,
  ) {}

  /** Every run here, as `listRuns` has them, opening only those new to this command. */
  async list(): Promise<Watched[]> {
    const runs = await listRuns(this.runRoot, (dir) => this.#runs.get(dir)?.run);
    this.#runs = new Map(runs.map((run) => [run.dir, this.#runs.get(run.dir) ?? this.entry(run)]));
    return [...this.#runs.values()];
  }

  entry(run: Run): Watched {
    return {
      run,
      attempts: [],
      labels: new Map(),
      fold: new ItemFold(),
      mark: { offset: 0, count: 0 },
      items: undefined,
      live: false,
      settled: false,
    };
  }

  /**
   * Brings `entry` up to date. `seen`, the cursor's last position in it, spares reading the log of
   * a run the cursor read to its end.
   */
  async read(entry: Watched, seen?: Position): Promise<void> {
    const { run } = entry;
    const token = await attemptsToken(run);
    if (token === entry.token && entry.settled) return;
    if (token !== entry.token) {
      const first = entry.token === undefined;
      entry.attempts = await readAttempts(run);
      entry.labels = await waitLabels(run.dir);
      entry.token = token;
      entry.settled = false;
      const last = entry.attempts.at(-1);
      if (first && seen && last?.outcome !== undefined && seen[1] >= last.attempt) {
        entry.items = [];
        entry.live = false;
        entry.settled = true;
        return;
      }
    }
    let status = statusOf(run, entry.attempts);
    // An attempt writes its end before its process exits: one gone with no end may have just ended.
    if (status.state === "interrupted" && entry.attempts.length > 0) {
      const again = await attemptsToken(run);
      if (again !== entry.token) {
        entry.attempts = await readAttempts(run);
        entry.labels = await waitLabels(run.dir);
        entry.token = again;
        status = statusOf(run, entry.attempts);
      }
    }
    entry.live = status.state === "running";
    // After the attempts: one that has ended has written its whole log.
    if ((await logSize(run.dir)) > entry.mark.offset) {
      const read = await readEventsFrom(run.dir, entry.mark);
      entry.fold.add(read.lines);
      entry.mark = read.mark;
    }
    entry.items = entry.fold.items(entry.attempts, entry.live, this.as, entry.labels);
    entry.settled = entry.attempts.length > 0 && status.checked && !entry.live;
  }
}

const EXPIRY: Partial<Record<RequestEnd, InboxExpiry>> = {
  "timed-out": "timeout",
  released: "released",
  cancelled: "cancelled",
  "attempt-ended": "attempt-ended",
};

type Numbered = { number: number; line: RunLogLine };

/**
 * A run's log folded into its items as lines are added, so a log is read once however often its
 * items are asked for. An attempt's `ended` item, and the questions it left open, are made when
 * asked for, from the attempts as read then: an attempt with no end whose process is gone, or
 * that a later attempt followed, was interrupted, and its open questions expire `attempt-ended`.
 */
export class ItemFold {
  readonly #items: Item[] = [];
  readonly #connected = new Set<string>();
  /** By attempt: the participants connected and their labels. */
  readonly #outside = new Map<number, Map<string, JsonObject | undefined>>();
  readonly #open = new Map<string, { participant: string; attempt: number }>();
  /** Each route as opened, by its ends, for the item that says it closed. */
  readonly #purposes = new Map<
    string,
    { purpose: string; timeoutMs?: number; labels?: JsonObject }
  >();
  /**
   * Where the log went on to a later attempt: the attempts that ended there, and the line before.
   * Attempt numbers only go up in a log, as only the live attempt writes it.
   */
  readonly #moves: { from: number; to: number; last: number; lastAt: string }[] = [];
  #attempt = 0;
  #last = 0;
  #lastAt = "";

  add(lines: readonly Numbered[]): this {
    for (const { number, line } of lines) this.#add(number, line);
    return this;
  }

  /** Its items in the log's order; undefined when it never connected a participant, or none under `as`. */
  items(
    attempts: readonly AttemptRecord[],
    live: boolean,
    as?: string,
    labels: ReadonlyMap<number, string> = new Map(),
  ): Item[] | undefined {
    if (as === undefined ? this.#connected.size === 0 : !this.#connected.has(as)) return undefined;
    const ends: Item[] = [];
    const lastAttempt = attempts.at(-1)?.attempt ?? 0;
    const end = (ended: number, last: number, lastAt: string) => {
      const record = attempts.find((each) => each.attempt === ended);
      const interrupted = !record?.outcome && (ended < lastAttempt || !live);
      if (!record?.outcome && !interrupted) return;
      let index = 0;
      if (interrupted)
        for (const [id, question] of this.#open)
          if (question.attempt === ended)
            ends.push({
              kind: "expired",
              participant: question.participant,
              id,
              reason: "attempt-ended",
              at: lastAt,
              position: [last, ended - 1, ++index],
            });
      const label = record?.outcome === "parked" ? labels.get(ended) : undefined;
      ends.push({
        kind: "ended",
        attempt: ended,
        outcome: record?.outcome ?? "interrupted",
        ...(label === undefined ? {} : { label }),
        at: record?.ended ?? lastAt,
        position: [last, ended, 0],
      });
    };
    for (const { from, to, last, lastAt } of this.#moves)
      for (let ended = from; ended < to; ended += 1) end(ended, last, lastAt);
    for (let ended = Math.max(this.#attempt, 1); ended <= lastAttempt; ended += 1)
      end(ended, this.#last, this.#lastAt);
    const items = [...this.#items, ...ends].sort((a, b) =>
      after(a.position, b.position) ? 1 : -1,
    );
    return as === undefined
      ? items
      : items.filter((item) => !("participant" in item) || item.participant === as);
  }

  #add(number: number, line: RunLogLine): void {
    const at = "at" in line && typeof line.at === "string" ? line.at : this.#lastAt;
    if (line.attempt !== this.#attempt) {
      if (this.#attempt >= 1 && line.attempt > this.#attempt)
        this.#moves.push({
          from: this.#attempt,
          to: line.attempt,
          last: this.#last,
          lastAt: this.#lastAt,
        });
      this.#attempt = line.attempt;
    }
    const attempt = this.#attempt;
    this.#last = number;
    this.#lastAt = at;
    const position: Position = [number, attempt - 1, 0];
    const here = this.#outside.get(attempt) ?? new Map<string, JsonObject | undefined>();
    this.#outside.set(attempt, here);
    const id = (n: number) => `${attempt}.${n}`;
    const items = this.#items;
    if (line.kind === "participant-connected") {
      here.set(line.participant, line.labels);
      this.#connected.add(line.participant);
      return;
    }
    if (line.kind === "participant-post") {
      items.push({
        kind: "post",
        participant: line.participant,
        id: `${attempt}.${line.id}`,
        text: line.text,
        ...(here.get(line.participant) === undefined ? {} : { labels: here.get(line.participant) }),
        at,
        position,
      });
      return;
    }
    if (line.kind === "route-opened" || line.kind === "route-closed") {
      const [a, b] = line.between ?? [line.from, line.to];
      const participant = here.has(a) ? a : here.has(b) ? b : undefined;
      if (participant === undefined) return;
      const agent = participant === a ? b : a;
      const direction = line.between
        ? "both"
        : line.from === participant
          ? "from-participant"
          : "to-participant";
      const labels = here.get(participant);
      const ends = JSON.stringify([attempt, participant, agent, direction]);
      if (line.kind === "route-opened")
        this.#purposes.set(ends, {
          purpose: line.purpose,
          ...(line.timeoutMs === undefined ? {} : { timeoutMs: line.timeoutMs }),
          ...(labels === undefined ? {} : { labels }),
        });
      // A closed route is said as it was opened, and why it closed.
      const opening = this.#purposes.get(ends) ?? { purpose: "" };
      items.push({
        kind: "route",
        state: line.kind === "route-opened" ? "opened" : "closed",
        participant,
        agent: address(line.callPath, agent),
        direction,
        ...opening,
        ...(line.kind === "route-closed" ? { reason: line.reason } : {}),
        at,
        position,
      });
      return;
    }
    if (line.kind === "message-sent") {
      if (here.has(line.from)) {
        if (line.replyTo !== undefined) {
          items.push({
            kind: "answered",
            participant: line.from,
            id: id(line.replyTo),
            answer: line.text,
            via: line.via ?? "command",
            at,
            position,
          });
          this.#open.delete(id(line.replyTo));
        } else
          items.push({
            kind: "message",
            participant: line.from,
            id: id(line.message),
            from: line.from,
            to: address(line.callPath, line.to),
            text: line.text,
            ...(line.via ? { via: line.via } : {}),
            at,
            position,
          });
        return;
      }
      if (!here.has(line.to)) return;
      const asks = line.awaitsReply !== undefined;
      items.push({
        kind: "message",
        participant: line.to,
        id: id(line.message),
        from: address(line.callPath, line.from),
        to: line.to,
        text: line.text,
        ...(asks ? { asks: true as const } : {}),
        ...(line.awaitsReply?.until ? { until: line.awaitsReply.until } : {}),
        at,
        position,
      });
      if (asks) this.#open.set(id(line.message), { participant: line.to, attempt });
      return;
    }
    if (line.kind === "request-ended" && here.has(line.owedBy) && line.end !== "replied") {
      items.push({
        kind: "expired",
        participant: line.owedBy,
        id: id(line.message),
        reason: EXPIRY[line.end] ?? "attempt-ended",
        at,
        position,
      });
      this.#open.delete(id(line.message));
    }
  }
}

function address(callPath: readonly string[], key: string): string {
  return [...callPath, key].join("/");
}

/** What is past the cursor in each run, oldest first across runs, each run's in its log's order. */
function newItems(runs: readonly RunItems[], state: CursorState): { ref: string; item: Item }[] {
  return merged(
    runs.map(({ ref, items }) => {
      const seen = state.r[ref];
      return { ref, items: items.filter((item) => !seen || after(item.position, seen)) };
    }),
  );
}

/** Oldest first across runs, by each run's next item: a run's own order holds whatever its times say. */
function merged<T extends { at: string }>(
  runs: readonly { ref: string; items: readonly T[] }[],
): { ref: string; item: T }[] {
  const queues = runs.map(({ ref, items }) => ({ ref, items: [...items] }));
  const out: { ref: string; item: T }[] = [];
  for (;;) {
    let next: (typeof queues)[number] | undefined;
    for (const queue of queues) {
      if (queue.items.length > 0 && (!next || queue.items[0]!.at < next.items[0]!.at)) next = queue;
    }
    if (!next) return out;
    out.push({ ref: next.ref, item: next.items.shift()! });
  }
}

function after(position: Position, seen: Position): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (position[index]! !== seen[index]!) return position[index]! > seen[index]!;
  }
  return false;
}

/** The questions open now, as their `message` items, with no cursor: a snapshot. */
function openQuestions(runs: readonly RunItems[]): InboxItemJson[] {
  const open = runs.map(({ ref, items }) => {
    const closed = new Set(
      items.flatMap((item) =>
        item.kind === "answered" || item.kind === "expired" ? [item.id] : [],
      ),
    );
    return {
      ref,
      items: items.filter((item) => item.kind === "message" && item.asks && !closed.has(item.id)),
    };
  });
  return merged(open).map(({ ref, item }) => {
    const { position: _position, ...shown } = item;
    return { v: 1, ref, ...shown } as InboxItemJson;
  });
}

/** What a run's agents wrote, safe on a terminal: credentials masked, no control characters. */
function safe(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
  return maskCredentials(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function textOf(item: InboxItemJson, all: boolean): string {
  const time = item.at ? clockTime(item.at).slice(0, 5) : "     ";
  const head = `${time}  ${all ? `${item.ref}  ` : ""}`;
  const body = (text: string) =>
    safe(text)
      .split("\n")
      .map((line) => `       ${line}`)
      .join("\n");
  switch (item.kind) {
    case "route": {
      const arrow =
        item.direction === "both"
          ? `${item.agent} ↔ ${item.participant}`
          : item.direction === "to-participant"
            ? `${item.agent} → ${item.participant}`
            : `${item.participant} → ${item.agent}`;
      return item.state === "opened"
        ? `${head}route ${arrow} opened  “${item.purpose}”${item.timeoutMs === undefined ? "" : `  ${duration(item.timeoutMs)}`}`
        : `${head}route ${arrow} closed  ${item.reason}`;
    }
    case "message": {
      const until = item.until ? `, until ${clockTime(item.until).slice(0, 5)}` : "";
      const via = item.via ? ` (${item.via})` : "";
      const what = item.asks
        ? `${item.from} asks ${item.to}${until}`
        : `${item.from} → ${item.to}${via}`;
      return `${head}${item.id}  ${what}\n${body(item.text)}`;
    }
    case "answered":
      return `${head}${item.id}  answered (${item.via})\n${body(item.answer)}`;
    case "post":
      return `${head}${item.id}  run → ${item.participant}\n${body(item.text)}`;
    case "expired":
      return `${head}${item.id}  closed unanswered: ${item.reason}`;
    case "ended":
      return `${head}attempt ${item.attempt} ended: ${item.outcome}`;
  }
}

function encodeCursor(state: CursorState): string {
  return `i1.${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
}

function decodeCursor(text: string): CursorState | undefined {
  try {
    if (!text.startsWith("i1.")) return undefined;
    const value: unknown = JSON.parse(Buffer.from(text.slice(3), "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { f, r } = value as { f?: unknown; r?: unknown };
    if (typeof f !== "string" || typeof r !== "object" || r === null) return undefined;
    for (const position of Object.values(r)) {
      if (
        !Array.isArray(position) ||
        position.length !== 3 ||
        !position.every((n) => typeof n === "number")
      )
        return undefined;
    }
    return { f, r: r as Record<string, Position> };
  } catch {
    return undefined;
  }
}

/** Each attempt's last wait label: what a parked attempt is waiting for. */
async function waitLabels(runDir: string): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  for (const record of await readMailbox(runDir))
    if (record.kind === "wait" && record.label !== undefined)
      labels.set(record.attempt, record.label);
  return labels;
}
