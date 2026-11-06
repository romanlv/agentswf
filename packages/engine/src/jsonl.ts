import { open, readFile } from "node:fs/promises";
import { isCode } from "./files";

const queues = new Map<string, Promise<void>>();

export function appendLine(path: string, line: string): Promise<void> {
  return queued(path, () => appendCompleteLine(path, line));
}

/** Runs `work` once every earlier write queued on `path` has settled, failed or not. */
export async function queued(path: string, work: () => Promise<void>): Promise<void> {
  const current = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(path, current);
  try {
    await current;
  } finally {
    if (queues.get(path) === current) queues.delete(path);
  }
}

async function appendCompleteLine(path: string, line: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await writeAll(handle, new TextEncoder().encode(`${line}\n`));
  } finally {
    await handle.close();
  }
}

type AppendWriter = {
  write(bytes: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
};

export async function writeAll(handle: AppendWriter, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) throw new Error("append made no progress");
    offset += bytesWritten;
  }
}

/**
 * Each line that parses as a JSON object, in order. One that doesn't is skipped wherever it is: a
 * crash can tear the last, and a later writer appends after it.
 */
export async function readLines<T extends object>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8").catch((error) => {
    if (isCode(error, "ENOENT")) return "";
    throw error;
  });
  return text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" && value !== null ? [value as T] : [];
    } catch {
      return [];
    }
  });
}

/** Ends a line a crash left torn, so the next line appended starts a line of its own. */
export async function endTornLine(path: string): Promise<void> {
  const handle = await open(path, "r").catch((error) => {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!handle) return;
  let torn: boolean;
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    torn = size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] !== 10;
  } finally {
    await handle.close();
  }
  if (torn) await appendLine(path, "");
}
