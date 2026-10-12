import { open } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * The rows from `from` on, and where the next read starts: after the last whole line. `cut`: a
 * tail read left lines before it; `more`: a bounded read stopped before the end.
 */
export type ActivityRead = { rows: ActivityRow[]; offset: number; cut?: boolean; more?: boolean };

/**
 * `file`'s activity from byte `from`, through its harness's row reader. A last line not yet ended
 * with a newline is left for the next read; a line that does not parse, or names no time, is passed.
 * A harness with no reader, or a file that cannot be read, gives nothing. `tail`: read from `0`, only
 * the whole lines of about that many last bytes. `lines`: stop after that many lines; `bytes`, at
 * the end of the line that reaches that many.
 */
export async function readActivity(
  harness: string,
  file: string,
  from = 0,
  options: { full?: boolean; tail?: number; lines?: number; bytes?: number } = {},
): Promise<ActivityRead> {
  const read = findHarness(harness)?.activityRow;
  if (!read) return { rows: [], offset: from };
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return { rows: [], offset: from };
  const rows: ActivityRow[] = [];
  let offset = from;
  try {
    const { size } = await handle.stat();
    // A file shorter than where the last read stopped was replaced: it is read again whole.
    if (size < from) offset = 0;
    // From the byte before, so the line it starts in is dropped whole, an empty one included.
    let partial = offset === 0 && options.tail !== undefined && size > options.tail;
    const cut = partial;
    if (partial) offset = size - options.tail! - 1;
    // In chunks, a native file may be hundreds of megabytes; a line runs on into the next.
    let pending = Buffer.alloc(0);
    let taken = 0;
    const begun = offset;
    // Past what was asked for, at the end of a whole line.
    const enough = (at: number) =>
      taken === options.lines || (options.bytes !== undefined && at - begun >= options.bytes);
    for (let position = offset; position < size && !enough(offset); ) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const bytes = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (
        let end = bytes.indexOf(10);
        end >= 0 && !enough(offset + start);
        end = bytes.indexOf(10, start)
      ) {
        const line = parseRow(bytes.subarray(start, end).toString("utf8"));
        const at = offset + start;
        start = end + 1;
        if (partial) {
          partial = false;
          continue;
        }
        taken += 1;
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
    return {
      rows,
      offset,
      ...(cut ? { cut } : {}),
      ...(offset < size && enough(offset) ? { more: true } : {}),
    };
  } catch {
    // What was read stands; the next read goes on from it.
    return { rows: rows.filter((row) => row.offset < offset), offset };
  } finally {
    await handle.close();
  }
}

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * A session's own file, the first its harness names: not a subagent's beside it, nor a forked
 * session's parent's, whose rows are theirs. Absent where the harness has no reader for its files.
 */
export async function ownSessionFile(
  harness: string,
  home: string,
  session: string,
  cwd: string,
): Promise<string | undefined> {
  const spec = findHarness(harness);
  if (!spec?.sessionFiles || !spec.activityRow) return undefined;
  const [own] = (await spec.sessionFiles(home, session, cwd).catch(() => undefined)) ?? [];
  return own === undefined ? undefined : join(home, own);
}

/**
 * Whether what was appended to a session's file from byte `from` shows `line` in a message from
 * its user: what a headless turn can say of the prompt it was given, which its harness writes as
 * the turn starts. Only what this turn wrote is read, so an earlier prompt with the same words is
 * never taken for it.
 */
export async function appendedShows(
  harness: string,
  file: string,
  from: number,
  line: string,
): Promise<boolean> {
  // Rows are read masked, so the line is too.
  const probe = maskCredentials(line);
  const read = await readActivity(harness, file, from, { full: true, lines: APPENDED_LINES });
  return read.rows.some(
    (row) =>
      row.activity.type === "message" && row.activity.from === "user" && row.text?.includes(probe),
  );
}

/** The prompt is among the first rows a turn appends; a few hundred lines is far past it. */
const APPENDED_LINES = 400;

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
