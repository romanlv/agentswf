import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tempRunDir } from "./deps";
import { appendTrial, readTrials } from "./run-log";

describe("appendTrial", () => {
  // Read-modify-write lost one of two concurrent appends, which is what E4 does all at once.
  test("concurrent appends all survive", async () => {
    const runDir = tempRunDir();
    await mkdir(runDir, { recursive: true });

    await Promise.all(
      Array.from({ length: 50 }, (_, index) => appendTrial(runDir, { index })),
    );

    const written = await readTrials<{ index: number }>(runDir);
    expect(written.map((row: { index: number }) => row.index).sort((a: number, b: number) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
  });
});
