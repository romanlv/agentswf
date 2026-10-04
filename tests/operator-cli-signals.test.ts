import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelOnSignals } from "../packages/engine/src/operator-cli";

const root = mkdtempSync(join(tmpdir(), "awf-signals-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the first stop signal cancels; a repeat at once is ignored, one pressed later exits", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const before = process.listenerCount(signal);
    const controller = new AbortController();
    const exits: number[] = [];
    let clock = 0;
    const stop = cancelOnSignals(
      controller,
      (code) => exits.push(code),
      () => clock,
    );
    process.emit(signal, signal);
    expect(controller.signal.reason).toBe(signal);
    // `bun awf`'s forwarded copy: with no listener left, it would take its default action.
    clock = 5;
    process.emit(signal, signal);
    expect(exits).toEqual([]);
    clock = 2_000;
    process.emit(signal, signal);
    expect(exits).toEqual([{ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]]);
    stop();
    expect(process.listenerCount(signal)).toBe(before);
  }
});

test("a cancelled run exits as the signal would, having written its record", async () => {
  const workflow = join(root, "waits.js");
  writeFileSync(
    workflow,
    `export default {
      kind: "awf.executable-workflow/v1",
      definition: {
        meta: { name: "waits", description: "waits to be cancelled" },
        async run() { console.error("started"); await new Promise(() => {}); },
      },
      prepare() { return null; },
    };`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../packages/engine/src/operator-cli.ts"),
      "run",
      "--run-root",
      join(root, "runs"),
      workflow,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: root } },
  );
  let stderr = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    stderr += decoder.decode(chunk);
    if (stderr.includes("started") && !child.killed) child.kill("SIGHUP");
  }
  expect(await child.exited).toBe(129);
  expect(stderr).toMatch(/^■ cancelled/m);
  const runs = join(root, "runs", "waits");
  expect([...new Bun.Glob("*/output.json").scanSync({ cwd: runs })]).toHaveLength(1);
  const [attempt] = [...new Bun.Glob("*/attempts/1.json").scanSync({ cwd: runs })];
  expect(JSON.parse(readFileSync(join(runs, attempt!), "utf8"))).toMatchObject({
    outcome: "cancelled",
  });
}, 30_000);
