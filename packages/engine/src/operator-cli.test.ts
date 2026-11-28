import { afterAll, describe, expect, test } from "bun:test";
import { cancelOnSignals, runOperatorCli, stderrLines } from "./operator-cli";
import { createTempRunDirs, eventProject } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

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

test("the first line of an attempt nobody watches says a continue is one, with its number", async () => {
  const { root, file, home } = eventProject(
    dirs,
    "fails.ts",
    `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "fails", description: "Fails." },
  async run() {
    throw new Error("boom");
  },
});
`,
  );
  const err: string[] = [];
  const awf = (...argv: string[]) =>
    runOperatorCli(["run", file, "--cwd", root, "--id", "f", ...argv], {
      home,
      environment: { ...process.env, HOME: home },
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
  expect(await awf()).toBe(1);
  expect(await awf("--continue")).toBe(1);
  const firsts = err.filter((line) => line.startsWith("awf: fails/f "));
  expect(firsts[0]).toStartWith("awf: fails/f started · watch: awf logs fails/f");
  expect(firsts[1]).toStartWith("awf: fails/f continued · attempt 2 · watch: awf logs fails/f");
});
