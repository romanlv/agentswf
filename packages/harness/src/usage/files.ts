import { readdir, stat } from "node:fs/promises";
import { jsonLines, type Row } from "../json";

/** An id reaches us from the agent's own shell, so it names a file and never a path. */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(id) && id !== "." && id !== "..";
}

/** A live session's last line may be half-written; `jsonLines` skips it. */
export async function jsonRows(path: string): Promise<Row[]> {
  try {
    return jsonLines(await Bun.file(path).text());
  } catch {
    return [];
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function entries(directory: string, recursive = false): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive })).map(String);
  } catch {
    return [];
  }
}
