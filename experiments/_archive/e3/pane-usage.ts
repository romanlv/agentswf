/**
 * What a pane turn cost. Herdr reports no usage, so every figure here comes from the harness's
 * own session log, found from the session reference the pane backend recorded with the call.
 *
 * A pooled pane puts several calls in one file, so turns are returned in order and the caller
 * picks by index. `null` means the log could not be read; that is not zero, and cursor is `null`
 * by construction — Herdr reports no session for a cursor pane and cursor writes no usage
 * anywhere on disk.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TurnUsage } from "../deps";
import type { Harness } from "../deps";

const HOME = process.env.HOME ?? "";

/** The cache split is kept apart from the sum: writes and reads are priced differently. */
export type Turn = TurnUsage & { cacheWriteTokens?: number; cacheReadTokens?: number };

export async function paneTurns(
  harness: Harness,
  sessionRef: string | null,
): Promise<Turn[] | null> {
  if (!sessionRef) return null;
  switch (harness) {
    case "claude":
      return claudeTurns(sessionRef);
    case "codex":
      return codexTurns(sessionRef);
    case "pi":
      return piTurns(sessionRef);
    case "cursor":
      return null;
  }
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function lines(path: string): Promise<Record<string, unknown>[] | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const rows: Record<string, unknown>[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A half-written last line is not a turn.
    }
  }
  return rows;
}

/** Assistant usage is attributed to the user message it follows, which is the turn. */
async function claudeTurns(sessionId: string): Promise<Turn[] | null> {
  const projects = join(HOME, ".claude", "projects");
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    const rows = await lines(join(projects, project, `${sessionId}.jsonl`));
    if (!rows) continue;
    const turns: Turn[] = [];
    // One API response is written out once per content block — a thinking block and the text
    // that follows it are two rows carrying the same `message.id` and the same `usage`. Adding
    // both doubles the turn. `e2/pane-cost.ts` has this bug; its pane cache figures are high.
    const counted = new Set<string>();
    for (const row of rows) {
      if (row.type === "user" && !row.isSidechain) {
        turns.push({
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        });
      }
      if (row.type !== "assistant" || turns.length === 0) continue;
      const message = record(row.message);
      const usage = record(message.usage);
      if (Object.keys(usage).length === 0) continue;
      const id = typeof message.id === "string" ? message.id : String(row.uuid);
      if (counted.has(id)) continue;
      counted.add(id);
      const turn = turns.at(-1)!;
      turn.inputTokens = (turn.inputTokens ?? 0) + num(usage.input_tokens);
      turn.outputTokens = (turn.outputTokens ?? 0) + num(usage.output_tokens);
      turn.cacheWriteTokens = (turn.cacheWriteTokens ?? 0) + num(usage.cache_creation_input_tokens);
      turn.cacheReadTokens = (turn.cacheReadTokens ?? 0) + num(usage.cache_read_input_tokens);
      turn.cachedInputTokens =
        (turn.cacheWriteTokens ?? 0) + (turn.cacheReadTokens ?? 0);
    }
    return turns.filter((turn) => (turn.outputTokens ?? 0) > 0);
  }
  return null;
}

/** codex writes `last_token_usage` once per model call; the last one in a turn is the turn. */
async function codexTurns(threadId: string): Promise<Turn[] | null> {
  const root = join(HOME, ".codex", "sessions");
  const found = await findFile(root, (name) => name.includes(threadId));
  if (!found) return null;
  const rows = await lines(found);
  if (!rows) return null;
  const turns: Turn[] = [];
  let open = false;
  for (const row of rows) {
    const payload = record(row.payload);
    if (payload.type === "task_started") {
      turns.push({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
      open = true;
    }
    if (payload.type === "token_count" && open && turns.length > 0) {
      const last = record(record(payload.info).last_token_usage);
      turns[turns.length - 1] = {
        inputTokens: num(last.input_tokens),
        outputTokens: num(last.output_tokens),
        cachedInputTokens: num(last.cached_input_tokens) + num(last.cache_write_input_tokens),
        cacheWriteTokens: num(last.cache_write_input_tokens),
        cacheReadTokens: num(last.cached_input_tokens),
      };
    }
    if (payload.type === "task_complete") open = false;
  }
  return turns;
}

/** pi's session reference is the log path itself, and it prices every assistant message. */
async function piTurns(sessionRef: string): Promise<Turn[] | null> {
  const path = sessionRef.startsWith("/")
    ? sessionRef
    : (await findFile(join(HOME, ".pi", "agent", "sessions"), (name) =>
        name.includes(sessionRef),
      )) ?? "";
  if (path === "") return null;
  const rows = await lines(path);
  if (!rows) return null;
  const turns: Turn[] = [];
  for (const row of rows) {
    if (row.type !== "message") continue;
    const message = record(row.message);
    if (message.role === "user") {
      turns.push({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      });
    }
    if (message.role !== "assistant" || turns.length === 0) continue;
    const usage = record(message.usage);
    if (Object.keys(usage).length === 0) continue;
    const turn = turns.at(-1)!;
    turn.inputTokens = (turn.inputTokens ?? 0) + num(usage.input);
    turn.outputTokens = (turn.outputTokens ?? 0) + num(usage.output);
    turn.cacheWriteTokens = (turn.cacheWriteTokens ?? 0) + num(usage.cacheWrite);
    turn.cacheReadTokens = (turn.cacheReadTokens ?? 0) + num(usage.cacheRead);
    turn.cachedInputTokens = (turn.cacheWriteTokens ?? 0) + (turn.cacheReadTokens ?? 0);
    turn.costUsd = (turn.costUsd ?? 0) + num(record(usage.cost).total);
  }
  return turns.filter((turn) => (turn.outputTokens ?? 0) > 0 || (turn.costUsd ?? 0) > 0);
}

async function findFile(
  root: string,
  matches: (name: string) => boolean,
): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(path, matches);
      if (nested) return nested;
    } else if (matches(entry.name)) {
      return path;
    }
  }
  return null;
}
