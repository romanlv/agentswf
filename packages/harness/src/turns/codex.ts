import { record, text } from "../json";
import { codexSessionsDirectory } from "../usage/codex";
import type { TurnReading, TurnRecordPlace } from "./record";

/** The text a codex row gives the operator's prompt in, if it is one. */
function promptText(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (payload.type === "message" && payload.role === "user") {
    const content = payload.content;
    if (!Array.isArray(content)) return text(content);
    return content.map((block) => text(record(block)?.text) ?? "").join("");
  }
  if (payload.type === "user_message") return text(payload.message);
  const item = record(payload.item);
  if (payload.type === "item_completed" && item?.type === "UserMessage") {
    const content = item.content;
    return Array.isArray(content)
      ? content.map((block) => text(record(block)?.text) ?? "").join("")
      : text(content);
  }
  return undefined;
}

const ANSWERS = new Set(["function_call", "custom_tool_call", "local_shell_call", "reasoning"]);

/**
 * A codex rollout's turn: the prompt carrying `marker` accepts it; the first row after naming a
 * `turn_id` names its turn, which `task_complete` or `turn_aborted` ends. A subagent's turns are
 * in rollouts of their own, and the turn that waits on them stays open in this one.
 */
export function createCodexTurnReducer(marker: string) {
  let accepted = false;
  let received = false;
  let turn: string | undefined;
  let ended: TurnReading["ended"];
  const reading = (): TurnReading => ({ accepted, received, ...(ended ? { ended } : {}) });
  return {
    push(value: unknown): TurnReading {
      const row = record(value);
      const payload = record(row?.payload);
      if (!row || !payload || ended) return reading();
      if (!accepted) {
        if (promptText(payload)?.includes(marker)) accepted = true;
        else return reading();
      }
      turn ??= text(payload.turn_id);
      if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        if (!turn || text(payload.turn_id) === turn) {
          ended = payload.type === "task_complete" ? "completed" : "interrupted";
        }
        return reading();
      }
      if (
        row.type === "response_item" &&
        ((payload.type === "message" && payload.role === "assistant") ||
          ANSWERS.has(String(payload.type)))
      ) {
        received = true;
      }
      return reading();
    },
  };
}

/** codex's day directories, `YYYY/MM/DD`, from a day before `since` to a day after now. */
function daysAround(since: number): string[] {
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
 * Where codex writes its rollouts: a directory per day it started a session, so the days around
 * `since`, and the one `session`'s rollout is in, where a resumed session started earlier.
 */
export function codexTurnPlace(
  since: number,
  home?: string,
  sessionFile?: string,
): TurnRecordPlace {
  const root = codexSessionsDirectory(home);
  const days = Number.isFinite(since) ? daysAround(since) : [];
  const own = sessionFile?.split("/").slice(0, -1).join("/");
  return {
    root,
    directories: own ? [...days, own] : days,
    ...(sessionFile ? { known: sessionFile } : {}),
  };
}

/**
 * codex's own compaction, read from its rollout: a task begun after the focus it was sent, with no
 * prompt of its own in it, that wrote a `compacted` row, then ended. A compaction codex ran itself
 * inside a turn is that turn's, not this.
 */
export function createCodexCompactionReducer() {
  let begun = false;
  let prompted = false;
  let compacted = false;
  let ended: TurnReading["ended"];
  return {
    push(value: unknown): TurnReading {
      const row = record(value);
      const payload = record(row?.payload);
      const type = payload?.type;
      if (row && !ended) {
        if (type === "task_started") {
          begun = true;
          prompted = false;
          compacted = false;
        } else if (promptText(payload) !== undefined) prompted = true;
        else if (row.type === "compacted" && !prompted) compacted = true;
        else if (type === "task_complete" || type === "turn_aborted") {
          if (compacted) ended = "completed";
        }
      }
      return { accepted: begun, received: compacted, ...(ended ? { ended } : {}) };
    },
  };
}
