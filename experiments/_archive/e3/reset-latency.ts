/**
 * How long a reset really takes, as opposed to how long `--wait` takes to give up on it.
 *
 * Submitting the slash command without `--wait` returns in milliseconds but the TUI has not
 * consumed it yet, and the next prompt lands concatenated onto it (`/clearWhat passphrase…`).
 * So the engine has to wait for something. This measures the cheapest thing there is to wait
 * for: the screen changing.
 *
 *   bun run e3/reset-latency.ts [harness ...]
 */
import { join } from "node:path";
import { poolDriver, RESET } from "./pool";
import { runProcess } from "../deps";
import type { Harness } from "../deps";

const HERE = join(import.meta.dir, "..");
const ALL: Harness[] = ["claude", "codex", "pi", "cursor"];
const only = process.argv.slice(2) as Harness[];
const harnesses = only.length > 0 ? only : ALL;

const SECRET = "MARMALADE-7719";
const PLANT = `Remember this passphrase for later: ${SECRET}. Reply with only the word ok.`;
const RECALL =
  "What passphrase were you asked to remember earlier in this conversation? " +
  "If there is no earlier passphrase in this conversation, reply with exactly NONE. " +
  "Reply with one word and nothing else.";

const driver = poolDriver({
  session: "wf-lab",
  workspaceLabel: "e3-reset-latency",
  commandTimeoutMs: 30_000,
  settleTimeoutMs: 180_000,
  cwd: HERE,
});

async function screen(name: string): Promise<string> {
  const result = await runProcess({
    argv: ["herdr", "--session", "wf-lab", "agent", "read", name, "--source", "detection"],
    timeoutMs: 15_000,
  });
  return result.stdout;
}

for (const harness of harnesses) {
  const row: Record<string, unknown> = { harness, reset: RESET[harness]?.command ?? null };
  try {
    const pane = await driver.open(harness, `latency-${harness}`);
    try {
      await pane.prompt(PLANT);
      const before = await screen(pane.name);
      const started = Date.now();
      await runProcess({
        argv: [
          "herdr",
          "--session",
          "wf-lab",
          "agent",
          "prompt",
          pane.name,
          RESET[harness]!.command,
        ],
        timeoutMs: 15_000,
      });
      const sleepMs = Number(process.env.RESET_SLEEP_MS ?? 0);
      if (sleepMs > 0) await Bun.sleep(sleepMs);
      let changedMs: number | null = null;
      for (let poll = 0; poll < 60 && sleepMs === 0; poll += 1) {
        const now = await screen(pane.name);
        if (now !== before) {
          changedMs = Date.now() - started;
          break;
        }
        await Bun.sleep(100);
      }
      row.sleepMs = sleepMs;
      row.screenChangedMs = changedMs;
      // Whatever the poll saw, give the same settle the wait path would and then check the
      // reset actually took: a fast screen change is worthless if the context survived.
      await pane.prompt(RECALL);
      const after = await screen(pane.name);
      row.recalledSecret = after.includes(SECRET);
      row.tail = after
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-10)
        .join(" | ")
        .slice(0, 400);
    } finally {
      await pane.close().catch(() => {});
    }
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify(row));
}
