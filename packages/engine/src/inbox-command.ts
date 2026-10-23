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
import {
  clockTime,
  command,
  failed,
  type Out,
  parsePlace,
  type ReadPlace,
  shellLine,
} from "./run-commands";
import { findRun, listRuns, RunNotFound, type RunStatus, runStatus } from "./run-state";
import { readAttempts, readNumberedEvents } from "./runs";

export const inboxUsage = [
  "usage: awf inbox <workflow>/<id> [--open] [--as <key>] [--after <cursor>] [--wait <seconds>]",
  "       awf inbox --all [--open] [--workflow <name>] [--as <key>] [--after <cursor>] [--wait <seconds>]",
  "                 [--cwd <directory>] [--run-root <directory>] [--json]",
  "",
  "What agents said to a coordinator outside the run, and what it said back: routes, messages,",
  "answers, questions that closed unanswered, and each attempt's end, oldest first. --all reads",
  "every run here that connected one. --after reads on from a cursor the last answer gave; --wait",
  "waits up to that many seconds, at most 300, when nothing is new. --open lists the questions",
  "still waiting for an answer, a snapshot. --json prints one item per line.",
  "",
  "Exits 0 on a read that worked, 1 when there is no such run, it has no coordinator, or the",
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

type Body<T> = T extends unknown ? Omit<T, "v" | "run" | "cursor"> : never;
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
  clock: InboxClock = REAL_CLOCK,
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
    for (;;) {
      const runs = await readInbox(place, options, state);
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
      if (fresh.length > 0 || clock.now() >= deadline) {
        const lines: string[] = [];
        for (const { ref, item } of fresh) {
          state = { f: filter, r: { ...state.r, [ref]: item.position } };
          const { position: _position, ...shown } = item;
          const published = {
            v: 1,
            run: ref,
            ...shown,
            cursor: encodeCursor(state),
          } as InboxItemJson;
          lines.push(json ? JSON.stringify(published) : safe(textOf(published, options.all)));
        }
        if (json) {
          for (const line of lines) out.stdout(line);
        } else {
          const words = options.all
            ? [
                "awf",
                "inbox",
                "--all",
                ...(options.workflow ? ["--workflow", options.workflow] : []),
              ]
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
    if (arg === "--all") options.all = true;
    else if (arg === "--open") options.open = true;
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
  if (options.all === (options.ref !== undefined))
    throw new Error("name a run, <workflow>/<id>, or read them all with --all");
  if (options.ref !== undefined && !options.ref.includes("/"))
    throw new Error(`a run is <workflow>/<id>, not ${options.ref}`);
  if (options.workflow !== undefined && !options.all)
    throw new Error("--workflow narrows --all; a run names its workflow already");
  if (options.open && (options.after !== undefined || options.waitSeconds > 0))
    throw new Error("--open is a snapshot: it takes no --after or --wait");
  return options;
}

type RunItems = { ref: string; items: Item[] };

/** The runs to read, each with its items; a run that never connected a coordinator has none. */
async function readInbox(
  place: ReadPlace,
  options: Options,
  state: CursorState,
): Promise<RunItems[]> {
  if (!options.all) {
    const { status } = await findRun(place.runRoot, options.ref);
    const items = await itemsOf(status, options.as);
    if (items === undefined && status.state !== "running")
      throw new Refused(
        "no-coordinator",
        `${status.ref} ended without connecting ${options.as ? `coordinator ${options.as}` : "a coordinator"}`,
      );
    return [{ ref: status.ref, items: items ?? [] }];
  }
  const found: RunItems[] = [];
  for (const run of await listRuns(place.runRoot)) {
    if (options.workflow !== undefined && run.record.workflow !== options.workflow) continue;
    const seen = state.r[`${run.record.workflow}/${run.record.id}`];
    // Its last attempt's end read already: nothing new comes until a continue adds an attempt.
    if (seen) {
      const last = (await readAttempts(run).catch(() => [])).at(-1);
      if (last?.outcome !== undefined && seen[1] >= last.attempt) continue;
    }
    // One that cannot be read is no reason to fail the others.
    const status = await runStatus(run).catch(() => undefined);
    if (!status) continue;
    const items = await itemsOf(status, options.as).catch(() => undefined);
    if (items) found.push({ ref: status.ref, items });
  }
  return found;
}

/** Undefined when the run never connected a coordinator, or none under `as`. */
async function itemsOf(status: RunStatus, as: string | undefined): Promise<Item[] | undefined> {
  const lines = await readNumberedEvents(status.run.dir);
  const attempts = await readAttempts(status.run);
  const items = buildItems(lines, attempts, status.state === "running");
  const connected = lines.some(
    ({ line }) =>
      line.kind === "participant-connected" && (as === undefined || line.participant === as),
  );
  if (!connected) return undefined;
  return as === undefined
    ? items
    : items.filter((item) => !("coordinator" in item) || item.coordinator === as);
}

const EXPIRY: Partial<Record<RequestEnd, InboxExpiry>> = {
  "timed-out": "timeout",
  released: "released",
  cancelled: "cancelled",
  "attempt-ended": "attempt-ended",
};

/**
 * Items in the log's order, each attempt's `ended` after its last line. An attempt with no end
 * whose process is gone, or that a later attempt followed, was interrupted: its open questions
 * expire `attempt-ended` and it ends `interrupted`.
 */
export function buildItems(
  lines: readonly { number: number; line: RunLogLine }[],
  attempts: readonly AttemptRecord[],
  live: boolean,
): Item[] {
  const items: Item[] = [];
  /** By attempt: the coordinators connected and their labels. */
  const outside = new Map<number, Map<string, JsonObject | undefined>>();
  const open = new Map<string, { coordinator: string; attempt: number }>();
  /** Each route as opened, by its ends, for the item that says it closed. */
  const purposes = new Map<string, { purpose: string; timeoutMs?: number; labels?: JsonObject }>();
  let attempt = 0;
  let last = 0;
  let lastAt = "";
  const address = (callPath: readonly string[], key: string) => [...callPath, key].join("/");
  const endAttempt = (ended: number) => {
    const record = attempts.find((each) => each.attempt === ended);
    const interrupted = !record?.outcome && (ended < (attempts.at(-1)?.attempt ?? 0) || !live);
    if (!record?.outcome && !interrupted) return;
    let index = 0;
    if (interrupted) {
      for (const [id, question] of open) {
        if (question.attempt !== ended) continue;
        items.push({
          kind: "expired",
          coordinator: question.coordinator,
          id,
          reason: "attempt-ended",
          at: lastAt,
          position: [last, ended - 1, ++index],
        });
        open.delete(id);
      }
    }
    items.push({
      kind: "ended",
      attempt: ended,
      outcome: record?.outcome ?? "interrupted",
      at: record?.ended ?? lastAt,
      position: [last, ended, 0],
    });
  };
  for (const { number, line } of lines) {
    const at = "at" in line && typeof line.at === "string" ? line.at : lastAt;
    if (line.attempt !== attempt) {
      for (let ended = attempt; ended >= 1 && ended < line.attempt; ended += 1) endAttempt(ended);
      attempt = line.attempt;
    }
    last = number;
    lastAt = at;
    const position: Position = [number, attempt - 1, 0];
    const here = outside.get(attempt) ?? new Map<string, JsonObject | undefined>();
    outside.set(attempt, here);
    const id = (n: number) => `${attempt}.${n}`;
    if (line.kind === "participant-connected") {
      here.set(line.participant, line.labels);
      continue;
    }
    if (line.kind === "route-opened" || line.kind === "route-closed") {
      const [a, b] = line.between ?? [line.from, line.to];
      const coordinator = here.has(a) ? a : here.has(b) ? b : undefined;
      if (coordinator === undefined) continue;
      const agent = coordinator === a ? b : a;
      const direction = line.between
        ? "both"
        : line.from === coordinator
          ? "from-coordinator"
          : "to-coordinator";
      const labels = here.get(coordinator);
      const ends = JSON.stringify([attempt, coordinator, agent, direction]);
      if (line.kind === "route-opened")
        purposes.set(ends, {
          purpose: line.purpose,
          ...(line.timeoutMs === undefined ? {} : { timeoutMs: line.timeoutMs }),
          ...(labels === undefined ? {} : { labels }),
        });
      // A closed route is said as it was opened, and why it closed.
      const opening = purposes.get(ends) ?? { purpose: "" };
      items.push({
        kind: "route",
        state: line.kind === "route-opened" ? "opened" : "closed",
        coordinator,
        agent: address(line.callPath, agent),
        direction,
        ...opening,
        ...(line.kind === "route-closed" ? { reason: line.reason } : {}),
        at,
        position,
      });
      continue;
    }
    if (line.kind === "message-sent") {
      if (here.has(line.from)) {
        if (line.replyTo !== undefined) {
          items.push({
            kind: "answered",
            coordinator: line.from,
            id: id(line.replyTo),
            answer: line.text,
            via: line.via ?? "command",
            at,
            position,
          });
          open.delete(id(line.replyTo));
        } else
          items.push({
            kind: "message",
            coordinator: line.from,
            id: id(line.message),
            from: line.from,
            to: address(line.callPath, line.to),
            text: line.text,
            ...(line.via ? { via: line.via } : {}),
            at,
            position,
          });
        continue;
      }
      if (!here.has(line.to)) continue;
      const asks = line.awaitsReply !== undefined;
      items.push({
        kind: "message",
        coordinator: line.to,
        id: id(line.message),
        from: address(line.callPath, line.from),
        to: line.to,
        text: line.text,
        ...(asks ? { asks: true as const } : {}),
        ...(line.awaitsReply?.until ? { until: line.awaitsReply.until } : {}),
        at,
        position,
      });
      if (asks) open.set(id(line.message), { coordinator: line.to, attempt });
      continue;
    }
    if (line.kind === "request-ended" && here.has(line.owedBy) && line.end !== "replied") {
      items.push({
        kind: "expired",
        coordinator: line.owedBy,
        id: id(line.message),
        reason: EXPIRY[line.end] ?? "attempt-ended",
        at,
        position,
      });
      open.delete(id(line.message));
    }
  }
  for (let ended = Math.max(attempt, 1); ended <= (attempts.at(-1)?.attempt ?? 0); ended += 1)
    endAttempt(ended);
  return items;
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
    return { v: 1, run: ref, ...shown } as InboxItemJson;
  });
}

/** What a run's agents wrote, safe on a terminal: credentials masked, no control characters. */
function safe(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
  return maskCredentials(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function textOf(item: InboxItemJson, all: boolean): string {
  const time = item.at ? clockTime(item.at).slice(0, 5) : "     ";
  const head = `${time}  ${all ? `${item.run}  ` : ""}`;
  const body = (text: string) =>
    safe(text)
      .split("\n")
      .map((line) => `       ${line}`)
      .join("\n");
  switch (item.kind) {
    case "route": {
      const arrow =
        item.direction === "both"
          ? `${item.agent} ↔ ${item.coordinator}`
          : item.direction === "to-coordinator"
            ? `${item.agent} → ${item.coordinator}`
            : `${item.coordinator} → ${item.agent}`;
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
