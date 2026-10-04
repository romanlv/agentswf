import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

/**
 * Whether `directory` and each directory above it below `home` is one, and not a link. `home` is
 * the engine's or the operator's own choosing, and may be a link.
 */
export async function ownDirectory(home: string, directory: string): Promise<boolean> {
  for (let path = directory; path.length >= home.length; path = dirname(path)) {
    const found = await (path === home ? stat(path) : lstat(path)).catch(() => undefined);
    if (!found?.isDirectory()) return false;
    if (path === home) return true;
  }
  return false;
}

/**
 * The files under `directory`, relative to it, where nothing from `home` down is a link: an
 * agent's home is its own to write, and a link there would have the engine count the operator's
 * sessions as the agent's.
 */
export async function ownFiles(home: string, directory: string): Promise<string[]> {
  if (!(await ownDirectory(home, directory))) return [];
  try {
    return (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
  } catch {
    return [];
  }
}
