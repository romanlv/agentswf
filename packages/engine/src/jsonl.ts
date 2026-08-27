import { open } from "node:fs/promises";

/**
 * O(1) and atomic for a line under PIPE_BUF. Read-modify-write would be O(n^2) across a run
 * and would lose one of two concurrent appends, which is exactly what E4 does.
 */
export async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.write(`${line}\n`);
  } finally {
    await handle.close();
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
