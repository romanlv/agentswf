import { open } from "node:fs/promises";

const appendQueues = new Map<string, Promise<void>>();

export async function appendLine(path: string, line: string): Promise<void> {
  const previous = appendQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => appendCompleteLine(path, line));
  appendQueues.set(path, current);
  try {
    await current;
  } finally {
    if (appendQueues.get(path) === current) appendQueues.delete(path);
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
  write(
    bytes: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesWritten: number }>;
};

export async function writeAll(handle: AppendWriter, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) throw new Error("append made no progress");
    offset += bytesWritten;
  }
}

export async function readLines<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}
