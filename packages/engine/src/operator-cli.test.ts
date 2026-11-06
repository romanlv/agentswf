import { describe, expect, test } from "bun:test";
import { cancelOnSignals, stderrLines } from "./operator-cli";

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

test("while a person's TUI has the terminal, Ctrl-C is its: awf neither cancels nor exits", () => {
  const controller = new AbortController();
  const exits: number[] = [];
  let attached = true;
  let now = 0;
  const stop = cancelOnSignals(
    controller,
    (code) => exits.push(code),
    () => now,
    () => attached,
  );
  // A signal's listeners are called with its name, as the process delivers it.
  const interrupt = () => {
    for (const listener of process.listeners("SIGINT")) listener("SIGINT");
  };
  try {
    interrupt();
    now = 5_000;
    interrupt();
    expect(controller.signal.aborted).toBe(false);
    expect(exits).toEqual([]);
    attached = false;
    interrupt();
    expect(controller.signal.aborted).toBe(true);
  } finally {
    stop();
  }
});
