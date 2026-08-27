import { describe, expect, test } from "bun:test";
import { tempRunDir } from "./testing";
import { readAccepted, writeAccepted } from "./run-dir";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("writeAccepted", () => {
  test("the first accepted value wins and a later one does not replace it", async () => {
    const runDir = tempRunDir();
    await mkdir(join(runDir, "calls", "c1"), { recursive: true });

    expect(await writeAccepted(runDir, "c1", { n: 1 })).toBe(true);
    expect(await writeAccepted(runDir, "c1", { n: 2 })).toBe(false);
    expect(await readAccepted(runDir, "c1")).toEqual({ value: { n: 1 } });
  });
});
