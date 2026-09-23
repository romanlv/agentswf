import { afterAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readAccepted, writeAcceptedExclusive } from "./run-dir";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

describe("writeAcceptedExclusive", () => {
  test("the first accepted value wins and a later one does not replace it", async () => {
    const runDir = tempRunDir();
    await mkdir(join(runDir, "calls", "c1"), { recursive: true });

    expect(await writeAcceptedExclusive(runDir, "c1", { n: 1 })).toBe(true);
    expect(await writeAcceptedExclusive(runDir, "c1", { n: 2 })).toBe(false);
    expect(await readAccepted(runDir, "c1")).toEqual({ value: { n: 1 } });
  });

  test("concurrent writers expose exactly one complete result", async () => {
    const runDir = tempRunDir();
    await mkdir(join(runDir, "calls", "c1"), { recursive: true });

    const claims = await Promise.all(
      Array.from({ length: 16 }, (_, n) => writeAcceptedExclusive(runDir, "c1", { n })),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    const accepted = await readAccepted(runDir, "c1");
    expect(accepted).not.toBeNull();
    expect(claims[Number((accepted!.value as { n: number }).n)]).toBe(true);
  });
});
