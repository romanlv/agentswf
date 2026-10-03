import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
 * root session in its `session_meta`, and is counted as delegated.
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
    // A subagent starts after its root, so it is never in an earlier day's directory.
    const day = dirname(file);
    for (const other of all) {
      if (dirname(other) < day) break;
      if (read.has(other) || !(await spawnedBy(join(root, other), id))) continue;
      read.add(other);
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

async function spawnedBy(path: string, id: string): Promise<boolean> {
  let head: string;
  try {
    head = await Bun.file(path).slice(0, 4096).text();
  } catch {
    return false;
  }
  const line = head.split("\n", 1)[0] ?? "";
  // The first line holds the whole system prompt and can outrun the slice, so it is matched as
  // text rather than parsed; `session_id` comes before it. The root's own id is already read.
  return line.includes('"type":"session_meta"') && line.includes(`"session_id":"${id}"`);
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
