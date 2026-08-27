/**
 * Does the pool's reset actually reset? One pane per harness: plant a secret, reset, then ask
 * for the secret back. A pool that leaks is not a cheaper pane, it is fourteen lenses that are
 * no longer independent, so this runs before the cost matrix rather than after it.
 *
 *   bun run e3/reset-probe.ts [harness ...]
 */
import { join } from "node:path";
import { poolDriver, RESET } from "./pool";
import type { Harness } from "../deps";

const HERE = join(import.meta.dir, "..");
const ALL: Harness[] = ["claude", "codex", "pi", "cursor"];
const only = process.argv.slice(2).filter((a) => !a.startsWith("-")) as Harness[];
const harnesses = only.length > 0 ? only : ALL;

const SECRET = "MARMALADE-7719";
const PLANT = `Remember this passphrase for later: ${SECRET}. Reply with only the word ok.`;
const RECALL =
  "What passphrase were you asked to remember earlier in this conversation? " +
  "If there is no earlier passphrase in this conversation, reply with exactly NONE. " +
  "Reply with one word and nothing else.";

const driver = poolDriver({
  session: "wf-lab",
  workspaceLabel: "e3-reset",
  commandTimeoutMs: 30_000,
  settleTimeoutMs: 180_000,
  resetSettleMs: Number(process.env.RESET_SETTLE_MS ?? 1_000),
  cwd: HERE,
});

for (const harness of harnesses) {
  const row: Record<string, unknown> = { harness, reset: RESET[harness]?.command ?? null };
  try {
    const pane = await driver.open(harness, `reset-${harness}`);
    try {
      await pane.prompt(PLANT);
      const before = (await pane.read()) ?? "";
      const reset = await pane.reset();
      const afterReset = (await pane.read()) ?? "";
      const recall = await pane.prompt(RECALL);
      row.recallState = recall.state;
      const after = (await pane.read()) ?? "";
      row.resetSupported = reset.supported;
      row.resetOk = reset.ok;
      row.resetMs = reset.ms;
      row.resetDetail = reset.detail ?? null;
      row.plantedVisible = before.includes(SECRET);
      row.screenClearedByReset = !afterReset.includes(SECRET);
      row.recalledSecret = after.includes(SECRET);
      row.recallTail = after.trim().split("\n").filter((l) => l.trim() !== "").slice(-14).join(" | ").slice(0, 900);
      row.afterResetTail = afterReset.trim().split("\n").filter((l) => l.trim() !== "").slice(-8).join(" | ").slice(0, 500);
    } finally {
      await pane.close().catch(() => {});
    }
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify(row));
}
