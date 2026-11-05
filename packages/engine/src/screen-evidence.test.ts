import { afterAll, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { screenFile, writeScreen } from "./runs";
import { createTempRunDirs, runNew, submit } from "./testing";
import type { RunnableWorkflow } from "./workflow-runner";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const DIALOG = "Allow this edit?\n> 1. Yes\n  2. No\n";

test("a turn that ends without an answer keeps its pane's screen; an answered one keeps none", async () => {
  const runRoot = runDirs.tempRunDir();
  const kinds: string[] = [];
  const adapter = createFakeAdapter({
    script: (context) =>
      context.prompt.includes("Edit.")
        ? { state: "blocked", detail: "a dialog is open", screen: DIALOG }
        : {
            screen: "done\n",
            act: async () => {
              await submit(context.binding!, "ok");
            },
          },
  });
  const workflow: RunnableWorkflow<null, null> = {
    meta: { name: "screens", description: "screens" },
    async run(wf) {
      const agent = await wf.agents.open({ key: "worker", runtime: "review" });
      for (const prompt of ["Edit.", "Answer."]) {
        const { outcome } = await agent.run({ prompt, schema: { type: "string" }, nudge: false });
        kinds.push(outcome.kind);
      }
      return null;
    },
  };
  await runNew(workflow, null, {
    runRoot,
    runtime: {
      aliases: { review: { harness: "fake", model: "fake" } },
      host: createSingleSessionHostFactory(adapter),
    },
  });
  expect(kinds).toEqual(["blocked", "answered"]);
  const runDir = await onlyRun(runRoot);
  const calls = await Array.fromAsync(new Bun.Glob("calls/*/call.json").scan({ cwd: runDir }));
  const screens = await Array.fromAsync(new Bun.Glob("calls/*/screen.txt").scan({ cwd: runDir }));
  expect(calls).toHaveLength(2);
  expect(screens).toHaveLength(1);
  const call = JSON.parse(await readFile(join(runDir, dirname(screens[0]!), "call.json"), "utf8"));
  expect(JSON.stringify(call)).toContain("Edit.");
  expect(await readFile(join(runDir, screens[0]!), "utf8")).toBe(DIALOG);
  expect((await stat(join(runDir, screens[0]!))).mode & 0o777).toBe(0o600);
});

test("a screen past the bound keeps its last whole lines", async () => {
  const runDir = runDirs.tempRunDir();
  const line = `${"x".repeat(99)}\n`;
  await writeScreen(runDir, "op", `first\n${line.repeat(1_000)}last\n`);
  const kept = await readFile(screenFile(runDir, "op"), "utf8");
  expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(64 * 1024);
  expect(kept.endsWith("last\n")).toBe(true);
  expect(kept.split("\n")[0]).toBe("x".repeat(99));
});

test("a screen whose last line alone is past the bound keeps its last bytes, whole characters", async () => {
  const runDir = runDirs.tempRunDir();
  await writeScreen(runDir, "long", `${"é".repeat(40_000)}\n`);
  const kept = await readFile(screenFile(runDir, "long"), "utf8");
  expect(kept.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(64 * 1024);
  expect(kept).not.toContain("\uFFFD");
  expect(kept.endsWith("é\n")).toBe(true);
});

async function onlyRun(runRoot: string): Promise<string> {
  const glob = new Bun.Glob("*/*/run.json");
  const found = await Array.fromAsync(glob.scan({ cwd: runRoot }));
  expect(found).toHaveLength(1);
  return join(runRoot, found[0]!, "..");
}
