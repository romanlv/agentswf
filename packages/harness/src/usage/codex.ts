import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { count, parseRow, type Row, record, text } from "../json";
import { harnessState } from "../state";
import { entries, jsonRows, safeId } from "./files";
import type { SessionRead, UsageRecord } from "./records";

/** Under `home`, the harness's home: the operator's unless an agent was given its own. */
export function codexSessionsDirectory(home = harnessState().codex): string {
  return join(home, "sessions");
}

/**
 * One record per response the rollout logged. A subagent writes a rollout of its own naming the
 * thread that spawned it in its `session_meta`, and is counted as that thread's, delegated.
 */
export async function readCodexUsage(
  sessions: readonly string[],
  root = codexSessionsDirectory(),
): Promise<SessionRead | undefined> {
  const ids = sessions.filter(safeId);
  if (ids.length === 0) return undefined;
  // Newest first by path, so the day directories a subagent can be in are the leading ones.
  const all = (await entries(root, true))
    .filter((name) => codexRolloutId(name) !== undefined)
    .sort()
    .reverse();
  const own = new Map<string, string>();
  for (const id of ids) {
    const found = all.find((name) => codexRolloutId(name) === id);
    if (found) own.set(id, found);
  }
  if (own.size === 0) return undefined;

  const records: UsageRecord[] = [];
  const read = new Set<string>();
  let open = false;
  for (const [id, file] of own) {
    if (read.has(file)) continue;
    read.add(file);
    const rows = await jsonRows(join(root, file));
    open ||= turnOpen(rows);
    records.push(...rolloutRecords(rows, file, false));
    // A subagent starts after the thread that spawned it, so it is never in an earlier day's
    // directory, and is read after it, oldest first.
    const day = dirname(file);
    const spawners = new Set([id]);
    for (const other of all.filter((name) => dirname(name) >= day).reverse()) {
      if (read.has(other)) continue;
      const parent = spawnerOf(await rolloutHead(join(root, other)));
      if (!parent || !spawners.has(parent)) continue;
      read.add(other);
      spawners.add(codexRolloutId(other)!);
      records.push(...rolloutRecords(await jsonRows(join(root, other)), other, true));
    }
  }
  return { records, open };
}

/**
 * The session started in `cwd` since `since` whose rollout holds `marker`: a pane's codex, whose
 * session Herdr does not name (E8), found by the operation id its prompt carries. Only the day
 * directories since then are read. The earliest started wins, since a subagent starts after the
 * session that delegates to it.
 */
export async function findCodexSession(
  marker: string,
  since: number,
  cwd: string,
  root = codexSessionsDirectory(),
): Promise<string | undefined> {
  // Codex records the directory it runs in as it resolves it.
  const places = new Set([cwd, await realpath(cwd).catch(() => cwd)]);
  let found: { id: string; started: number } | undefined;
  for (const day of daysSince(since)) {
    for (const name of await entries(join(root, day))) {
      const id = codexRolloutId(name);
      if (!id) continue;
      let text: string;
      try {
        text = await Bun.file(join(root, day, name)).text();
      } catch {
        continue;
      }
      const meta = record(parseRow(text.slice(0, text.indexOf("\n")))?.payload);
      const started = Date.parse(String(meta?.timestamp));
      if (!(started >= since) || !places.has(String(meta?.cwd)) || !text.includes(marker)) {
        continue;
      }
      if (!found || started < found.started) found = { id, started };
    }
  }
  return found?.id;
}

/** Codex's day directories, `YYYY/MM/DD`, from `since` to now, in local time and in UTC. */
function daysSince(since: number): string[] {
  const days = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let at = since - 86_400_000; at <= Date.now() + 86_400_000; at += 3_600_000) {
    const date = new Date(at);
    days.add(`${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`);
    days.add(`${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`);
  }
  return [...days];
}

/**
 * The rollouts thread `id` is made of, relative to `home`: its own, and those of each thread it was
 * forked from, which a fork refers to rather than copies (F8).
 */
export async function codexSessionFiles(home: string, id: string): Promise<string[] | undefined> {
  const root = codexSessionsDirectory(home);
  const all = (await entries(root, true)).filter((name) => codexRolloutId(name) !== undefined);
  const files: string[] = [];
  for (let thread: string | undefined = id; thread; ) {
    const name = all.find((each) => codexRolloutId(each) === thread);
    if (!name || files.includes(name)) break;
    files.push(name);
    thread = metaField(await rolloutHead(join(root, name)), "forked_from_id");
  }
  return files.length === 0 ? undefined : files.map((name) => relative(home, join(root, name)));
}

/**
 * Gives thread `fork`, forked from `parent` under `home`, its parent's session id. Codex keys its
 * prompt cache, and the ChatGPT backend routes requests, by the session id a resumed thread reads
 * from its rollout's `session_meta`; a fork writes its own id there and misses its parent's cache,
 * where codex's own subagents keep the root's and hit it (F4, F10). Left as it is where a codex
 * writes no session id.
 */
export async function inheritCodexSessionId(
  home: string,
  parent: string,
  fork: string,
): Promise<void> {
  const [parentFile] = (await codexSessionFiles(home, parent)) ?? [];
  const [forkFile] = (await codexSessionFiles(home, fork)) ?? [];
  if (!parentFile || !forkFile || codexRolloutId(forkFile) !== fork) {
    throw new Error(`codex left no rollout of ${fork} forked from ${parent} under ${home}`);
  }
  const session = metaField(await rolloutHead(join(home, parentFile)), "session_id");
  const path = join(home, forkFile);
  // The home may be a sandboxed agent's, which it can write. The rollout is opened once, never
  // through a link, and only a regular file of its own is written, in place: a path swapped after
  // the check, or a FIFO, is never reached, and nothing codex appends meanwhile is lost.
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === "ELOOP" ? `${path} is a link` : error.message);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${path} is not a rollout of its own`);
    const head = await readHead(handle);
    if (metaField(head, "id") !== fork || metaField(head, "forked_from_id") !== parent) {
      throw new Error(`${path} is not ${fork}'s fork of ${parent}`);
    }
    const own = metaField(head, "session_id");
    if (!session || !own || own === session || !safeId(session)) return;
    if (own.length !== session.length) {
      throw new Error(`codex's session ids ${own} and ${session} differ in length`);
    }
    const at = Buffer.byteLength(head.slice(0, head.indexOf(`"session_id":"${own}"`)));
    await handle.write(Buffer.from(`"session_id":"${session}"`), 0, undefined, at);
  } finally {
    await handle.close();
  }
}

/**
 * The start of a rollout's first line, which holds the whole system prompt and can outrun it:
 * every field read from it comes before. Read without following a link or waiting on what is not
 * a file; `""` where there is none.
 */
async function rolloutHead(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (!handle) return "";
  try {
    return (await handle.stat()).isFile() ? await readHead(handle) : "";
  } finally {
    await handle.close();
  }
}

async function readHead(handle: FileHandle): Promise<string> {
  const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
  const head = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
  return head.includes('"type":"session_meta"') ? head : "";
}

/** A string field of a rollout's `session_meta`, its first occurrence in the head. */
function metaField(head: string, field: string): string | undefined {
  return new RegExp(`"${field}":"([^"\\\\]+)"`).exec(head)?.[1];
}

/**
 * The thread a subagent's rollout was spawned by: its `parent_thread_id`, or, from a codex that
 * wrote none, the root its `session_id` names. A rollout whose `source` is a string is a session
 * of its own, a fork awf gave its parent's session id included, and was spawned by none.
 */
function spawnerOf(head: string): string | undefined {
  if (!head || head.includes('"source":"')) return undefined;
  return metaField(head, "parent_thread_id") ?? metaField(head, "session_id");
}

/** The agent's own turn: a subagent it is still waiting on keeps that turn open too. */
function turnOpen(rows: readonly Row[]): boolean {
  const last = rows.findLast((row) => {
    const type = record(row.payload)?.type;
    return type === "task_started" || type === "task_complete" || type === "turn_aborted";
  });
  return record(last?.payload)?.type === "task_started";
}

/** The session id a codex rollout's file name ends with, after its start time. */
export function codexRolloutId(path: string): string | undefined {
  return /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(basename(path))?.[1];
}

function rolloutRecords(rows: readonly Row[], file: string, delegated: boolean): UsageRecord[] {
  const id = codexRolloutId(file)!;
  const meta = record(rows.find((row) => row.type === "session_meta")?.payload);
  const provider = text(meta?.model_provider) ?? "openai";
  // A session resumed on a newer CLI has token counts up to its first per-response row.
  const first = rows.findIndex(
    (row) => row.type === "token_usage_record" && record(row.payload)?.thread_id === id,
  );
  const before = first === -1 ? rows : rows.slice(0, first);
  return [
    ...countedRecords(before, id, provider, delegated),
    ...(first === -1 ? [] : responseRecords(rows, id, provider, delegated)),
  ];
}

/**
 * CLI 0.155 onward logs each response once, compaction included, and names its turn. Each row names
 * its thread, and only this rollout's own are its spend.
 */
function responseRecords(
  rows: readonly Row[],
  id: string,
  provider: string,
  delegated: boolean,
): UsageRecord[] {
  const models = new Map<string, string>();
  const records: UsageRecord[] = [];
  let model = "unknown";
  for (const row of rows) {
    const payload = record(row.payload);
    if (row.type === "turn_context") {
      model = text(payload?.model) ?? model;
      const turn = text(payload?.turn_id);
      if (turn) models.set(turn, model);
      continue;
    }
    if (row.type !== "token_usage_record" || payload?.thread_id !== id) continue;
    const usage = record(payload.usage);
    const key = text(payload.response_id);
    const at = text(row.timestamp);
    if (!usage || !key || !at) continue;
    records.push({
      key,
      at,
      model: models.get(text(payload.turn_id) ?? "") ?? model,
      ...common(usage, provider, delegated),
    });
  }
  return records;
}

/**
 * Older rollouts have only `token_count`: the latest request's usage beside a running total. A
 * total that moved marks a new request; one that did not is the same request reported again. The
 * total itself is never differenced, because a rollout carried over from a compacted thread opens
 * on the old thread's total.
 */
function countedRecords(
  rows: readonly Row[],
  id: string,
  provider: string,
  delegated: boolean,
): UsageRecord[] {
  const records: UsageRecord[] = [];
  let model = "unknown";
  let previous: string | undefined;
  for (const [index, row] of rows.entries()) {
    const payload = record(row.payload);
    if (row.type === "turn_context") {
      model = text(payload?.model) ?? model;
      continue;
    }
    if (payload?.type !== "token_count") continue;
    const info = record(payload.info);
    const total = record(info?.total_token_usage);
    const last = record(info?.last_token_usage);
    const at = text(row.timestamp);
    if (!total || !last || !at) continue;
    const marker = JSON.stringify(total);
    if (marker === previous) continue;
    previous = marker;
    if (count(last.input_tokens) + count(last.output_tokens) === 0) continue;
    records.push({ key: `${id}#${index}`, at, model, ...common(last, provider, delegated) });
  }
  return records;
}

function common(
  usage: Row,
  provider: string,
  delegated: boolean,
): Pick<UsageRecord, "provider" | "delegated" | "tokens"> {
  const input = count(usage.input_tokens);
  const cached = Math.min(input, count(usage.cached_input_tokens));
  const output = count(usage.output_tokens);
  return {
    provider,
    delegated,
    tokens: {
      // OpenAI's input includes the cached part, and its output the reasoning.
      input: input - cached,
      cacheRead: cached,
      // Zero on OpenAI, which charges nothing extra to write its cache.
      cacheWrite: count(usage.cache_write_input_tokens),
      output,
      reasoning: Math.min(output, count(usage.reasoning_output_tokens)),
    },
  };
}
