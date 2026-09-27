import { basename, isAbsolute, join, relative } from "node:path";
import { count, record, text } from "../json";
import { harnessState } from "../state";
import { entries, isFile, jsonRows, safeId } from "./files";
import type { SessionRead, UsageRecord } from "./records";

/**
 * pi logs each assistant message with its own usage, `input` already excluding the cached part.
 * A pane reports the session as its file path and `wf` as its id, so both resolve to one file; a
 * forked session copies its parent's entries under their ids, so one entry is one request.
 */
export async function readPiUsage(
  sessions: readonly string[],
  agentDirectory = harnessState().pi,
): Promise<SessionRead | undefined> {
  const root = join(agentDirectory, "sessions");
  const files = new Set<string>();
  for (const ref of sessions) {
    const file = await resolve(root, ref);
    if (file) files.add(file);
  }
  if (files.size === 0) return undefined;

  const records = new Map<string, UsageRecord>();
  for (const file of files) {
    for (const row of await jsonRows(file)) {
      const message = record(row.message);
      const usage = record(message?.usage);
      const id = text(row.id);
      const at = text(row.timestamp);
      if (row.type !== "message" || message?.role !== "assistant" || !usage || !id || !at) continue;
      // A failed request is logged as a message with zero usage; it bills nothing.
      if (message.stopReason === "error") continue;
      const provider = text(message.provider);
      records.set(`${id}@${at}`, {
        key: `${id}@${at}`,
        at,
        model: text(message.model) ?? "unknown",
        ...(provider ? { provider } : {}),
        delegated: false,
        tokens: {
          input: count(usage.input),
          cacheRead: count(usage.cacheRead),
          cacheWrite: count(usage.cacheWrite),
          output: count(usage.output),
          ...(typeof usage.reasoning === "number" ? { reasoning: count(usage.reasoning) } : {}),
        },
      });
    }
  }
  // A headless pi has ended by the time the run does; a pane's open turn is not read yet.
  return { records: [...records.values()], open: false };
}

async function resolve(root: string, ref: string): Promise<string | undefined> {
  if (isAbsolute(ref)) {
    const inside = relative(root, ref);
    return ref.endsWith(".jsonl") && !inside.startsWith("..") && (await isFile(ref))
      ? ref
      : undefined;
  }
  if (!safeId(ref)) return undefined;
  for (const directory of await entries(root)) {
    for (const name of await entries(join(root, directory))) {
      if (sessionId(name) === ref) return join(root, directory, name);
    }
  }
  return undefined;
}

/** `<timestamp>_<id>.jsonl`. */
function sessionId(name: string): string | undefined {
  const file = basename(name);
  const separator = file.indexOf("_");
  return separator > 0 && file.endsWith(".jsonl") ? file.slice(separator + 1, -6) : undefined;
}
