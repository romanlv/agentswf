import { describe, expect, test } from "bun:test";
import { stderrLines } from "./operator-cli";

describe("awf's stderr", () => {
  test("paints only its own failures, and only when asked", () => {
    const written: string[] = [];
    const colored = stderrLines((text) => written.push(text), { color: true });
    colored("[00:01] ▶ review: 3 files");
    colored("awf: run failed; artifacts retained under /runs/x: boom");
    colored("awf: unknown flag --x\n\nusage: awf run");
    const plain = stderrLines((text) => written.push(text), { color: false });
    plain("awf: run failed");

    expect(written).toEqual([
      "[00:01] ▶ review: 3 files\n",
      "\x1b[31mawf: run failed; artifacts retained under /runs/x: boom\x1b[39m\n",
      "\x1b[31mawf: unknown flag --x\x1b[39m\n\nusage: awf run\n",
      "awf: run failed\n",
    ]);
  });
});
