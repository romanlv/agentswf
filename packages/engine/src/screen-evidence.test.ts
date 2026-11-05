import { afterAll, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { screenFile, writeScreen } from "./ops";
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
  const ops = await Array.fromAsync(new Bun.Glob("ops/*/op.json").scan({ cwd: runDir }));
  const screens = await Array.fromAsync(new Bun.Glob("ops/*/screen.txt").scan({ cwd: runDir }));
  expect(ops.sort()).toEqual(["ops/worker.1/op.json", "ops/worker.2/op.json"]);
  expect(screens).toEqual(["ops/worker.1/screen.txt"]);
  const op = JSON.parse(await readFile(join(runDir, "ops/worker.1/op.json"), "utf8"));
  expect(op).toMatchObject({ id: "worker.1", kind: "turn", attempt: 1, agent: "worker" });
  expect(op.question).toContain("Edit.");
  expect(await readFile(join(runDir, screens[0]!), "utf8")).toBe(DIALOG);
  expect((await stat(join(runDir, screens[0]!))).mode & 0o777).toBe(0o600);
});

test("an agent whose start failed keeps the screen its pane showed, in its operation's folder", async () => {
  const runRoot = runDirs.tempRunDir();
  const startScreen = "codex: command not found\n";
  const adapter = createFakeAdapter({
    script: () => ({ state: "failed", detail: "agent start failed", screen: startScreen }),
  });
  const workflow: RunnableWorkflow<null, string> = {
    meta: { name: "failed-start", description: "failed start" },
    async run(wf) {
      const agent = await wf.agents.open({ key: "worker", runtime: "review" });
      const { outcome } = await agent.run({ prompt: "Start.", nudge: false });
      return outcome.kind;
    },
  };
  const result = await runNew(workflow, null, {
    runRoot,
    runtime: {
      aliases: { review: { harness: "fake", model: "fake" } },
      host: createSingleSessionHostFactory(adapter),
    },
  });
  expect(result.value).toBe("failed");
  const runDir = await onlyRun(runRoot);
  expect(await readFile(screenFile(runDir, "worker.1"), "utf8")).toBe(startScreen);
  expect(screenFile(runDir, "worker.1")).toBe(join(runDir, "ops", "worker.1", "screen.txt"));
  expect(
    JSON.parse(await readFile(join(runDir, "ops", "worker.1", "op.json"), "utf8")),
  ).toMatchObject({
    id: "worker.1",
    kind: "turn",
    attempt: 1,
    agent: "worker",
    question: "Start.",
  });
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
