import { open } from "node:fs/promises";
import type { Activity } from "@agentswf/contract/records";
import { parseRow, type Row } from "../json";
import { findHarness } from "../spec";
import { maskCredentials } from "./mask";

/** What one native row says the agent did, in order: a claude message may hold several. */
export type ActivityItem = { activity: Activity; text?: string };
export type ActivityLine = { at?: string; items: ActivityItem[] };

/**
 * One thing the agent did, at the byte offset of the line it was read from: a line is only ever
 * appended, or rewritten in place at the same length, so the offset names it for good. `index` is
 * its place among the line's items. `text` is the whole of it, masked, when asked for.
 */
export type ActivityRow = {
  at: string;
  offset: number;
  index: number;
  activity: Activity;
  text?: string;
};

/** The rows from `from` on, and where the next read starts: after the last whole line. */
export type ActivityRead = { rows: ActivityRow[]; offset: number };

/**
 * `file`'s activity from byte `from`, through its harness's row reader. A last line not yet ended
 * with a newline is left for the next read; a line that does not parse, or names no time, is passed.
 * A harness with no reader, or a file that cannot be read, gives nothing.
 */
export async function readActivity(
  harness: string,
  file: string,
  from = 0,
  options: { full?: boolean } = {},
): Promise<ActivityRead> {
  const read = findHarness(harness)?.activityRow;
  if (!read) return { rows: [], offset: from };
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return { rows: [], offset: from };
  const rows: ActivityRow[] = [];
  try {
    const { size } = await handle.stat();
    // A file shorter than where the last read stopped was replaced: it is read again whole.
    let offset = size < from ? 0 : from;
    // In chunks, a native file may be hundreds of megabytes; a line runs on into the next.
    let pending = Buffer.alloc(0);
    for (let position = offset; position < size; ) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const bytes = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
        const line = parseRow(bytes.subarray(start, end).toString("utf8"));
        const at = offset + start;
        start = end + 1;
        const said = line && read(line);
        if (!said?.at) continue;
        said.items.forEach(({ activity, text }, index) => {
          rows.push({
            at: said.at!,
            offset: at,
            index,
            activity,
            ...(options.full && text !== undefined ? { text: maskCredentials(text) } : {}),
          });
        });
      }
      offset += start;
      pending = bytes.subarray(start);
    }
    return { rows, offset };
  } catch {
    return { rows, offset: from };
  } finally {
    await handle.close();
  }
}

const CHUNK_BYTES = 4 * 1024 * 1024;

/** The text of a content block list, or of a string: what a message says. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const text = (block as Row | undefined)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** The argument worth showing for a call: a command, a path, a pattern, or the input as JSON. */
export function argumentOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Row;
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "url", "query", "prompt"]) {
    const value = fields[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      return value.join(" ");
    }
  }
  return JSON.stringify(input);
}
