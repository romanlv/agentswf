import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appendLine, readLines, writeAll } from "./jsonl";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

describe("JSONL persistence", () => {
  test("keeps concurrent large lines readable", async () => {
    const path = join(tempRunDir(), "attempts.jsonl");
    const records = Array.from({ length: 12 }, (_, index) => ({
      index,
      raw: String(index).repeat(100_000),
    }));

    await Promise.all(records.map((record) => appendLine(path, JSON.stringify(record))));

    expect(
      (await readLines<(typeof records)[number]>(path)).sort((a, b) => a.index - b.index),
    ).toEqual(records);
  });

  test("completes short writes and rejects zero progress", async () => {
    const writes: Array<{ offset: number; length: number }> = [];
    const shortWriter = {
      async write(_bytes: Uint8Array, offset: number, length: number) {
        writes.push({ offset, length });
        return { bytesWritten: Math.min(2, length), buffer: _bytes };
      },
    };

    await writeAll(shortWriter, new Uint8Array(5));
    expect(writes).toEqual([
      { offset: 0, length: 5 },
      { offset: 2, length: 3 },
      { offset: 4, length: 1 },
    ]);
    await expect(
      writeAll(
        {
          async write(_bytes: Uint8Array) {
            return { bytesWritten: 0, buffer: _bytes };
          },
        },
        new Uint8Array(1),
      ),
    ).rejects.toThrow("no progress");
  });
});
