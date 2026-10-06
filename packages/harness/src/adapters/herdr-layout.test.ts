import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneLayout } from "@agentswf/contract/workflow";
import type { AgentRunHost } from "../adapter";
import { createFakeHerdr, type FakeHerdr } from "../testing/herdr-cli";
import { createHerdrRunHostFactory, type HerdrConfig } from "./herdr";

let originalClaudeHome: string | undefined;
let isolatedClaudeHome: string;
beforeAll(() => {
  originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  isolatedClaudeHome = mkdtempSync(join(tmpdir(), "awf-herdr-layout-claude-"));
  process.env.CLAUDE_CONFIG_DIR = isolatedClaudeHome;
});
afterAll(() => {
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
  rmSync(isolatedClaudeHome, { recursive: true, force: true });
});

const CONFIG: HerdrConfig = {
  session: "awf",
  workspaceLabel: "awf run",
  commandTimeoutMs: 5_000,
  acceptWorkspaceTrust: true,
  startRetryMs: 0,
  trustSettleMs: 0,
};
const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });

async function openRun(herdr: FakeHerdr) {
  return createHerdrRunHostFactory(CONFIG, herdr.run).openRun({
    runId: "r1",
    label: "awf review r1",
    cwd: "/repo",
    deadline: deadline(),
  });
}

function open(
  host: AgentRunHost,
  key: string,
  layout?: PaneLayout,
  extra: { layoutFallback?: string } = {},
) {
  return host.openAgent({
    key,
    cwd: "/repo",
    deadline: deadline(),
    execution: { harness: "claude", model: "opus" },
    ...(layout ? { layout } : {}),
    ...extra,
  });
}

const paneOf = (herdr: FakeHerdr, label: string) =>
  [...herdr.panes.entries()].find(([, pane]) => pane.label === label);
const calls = (herdr: FakeHerdr, verb: string) =>
  herdr.calls.filter((call) => call.argv.slice(3, 5).join(" ") === verb);

describe("pane layout in the run's Herdr", () => {
  test("a pane is placed at open, in a tab of its own labelled by its key, or by `tab`", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const plain = await open(host, "plain");
    const named = await open(host, "lead", { tab: "review" });
    expect(calls(herdr, "agent start")).toHaveLength(0);
    expect(
      calls(herdr, "tab create").map((call) => call.argv[call.argv.indexOf("--label") + 1]),
    ).toEqual(["plain", "review"]);
    expect(plain.pane?.()).toEqual({ session: "awf", workspace: "run", tab: "plain" });
    expect(named.pane?.()).toEqual({ session: "awf", workspace: "run", tab: "review" });
    expect(paneOf(herdr, "lead")).toBeDefined();
    await host.close();
    expect(herdr.openWorkspaces()).toEqual([]);
  });

  test("two columns, the right one stacked: splits beside earlier agents, by share", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [], rootColumns: 200 });
    const host = await openRun(herdr);
    await open(host, "lead", { tab: "review" });
    const security = await open(host, "security", { beside: "lead", side: "right" });
    const style = await open(host, "style", { beside: "security", side: "below", share: 0.4 });
    const [, lead] = paneOf(herdr, "lead")!;
    const [, right] = paneOf(herdr, "security")!;
    const [, below] = paneOf(herdr, "style")!;
    expect(new Set([lead.tab, right.tab, below.tab]).size).toBe(1);
    expect(lead.rect).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(right.rect).toEqual({ x: 100, y: 0, width: 100, height: 30 });
    expect(below.rect).toEqual({ x: 100, y: 30, width: 100, height: 20 });
    expect(
      calls(herdr, "pane split").map((call) => call.argv[call.argv.indexOf("--ratio") + 1]),
    ).toEqual(["0.5", "0.6"]);
    expect(calls(herdr, "tab create")).toHaveLength(1);
    expect(security.pane?.()).toEqual({ session: "awf", workspace: "run", beside: "lead" });
    expect(style.pane?.()).toEqual({ session: "awf", workspace: "run", beside: "security" });
    await host.close();
  });

  test("a split that would leave a pane under 1/8 of the tab falls back to a tab of its own", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [], rootColumns: 80 });
    const host = await openRun(herdr);
    await open(host, "a");
    await open(host, "b", { beside: "a", side: "right", share: 0.8 });
    const c = await open(host, "c", { beside: "a", side: "right", share: 0.8 });
    expect(c.pane?.()).toEqual({
      session: "awf",
      workspace: "run",
      tab: "c",
      fallback: "the split would leave a pane 3 of the tab's 80 columns, under 1/8",
    });
    expect(calls(herdr, "pane split")).toHaveLength(1);
    await host.close();
  });

  test("beside an agent whose pane closed, or that the host never placed, falls back", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const gone = await open(host, "gone");
    await gone.close();
    const after = await open(host, "after", { beside: "gone", side: "right" });
    const nowhere = await open(host, "nowhere", { beside: "missing", side: "below" });
    const told = await open(
      host,
      "told",
      { beside: "after", side: "right" },
      {
        layoutFallback: "after is headless",
      },
    );
    expect(after.pane?.()?.fallback).toBe("gone's pane is closed");
    expect(nowhere.pane?.()?.fallback).toBe("missing has no pane");
    expect(told.pane?.()).toEqual({
      session: "awf",
      workspace: "run",
      tab: "told",
      fallback: "after is headless",
    });
    expect(calls(herdr, "pane split")).toHaveLength(0);
    await host.close();
  });

  test("Herdr refusing the split falls back to a tab in the target's workspace", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    await open(host, "a");
    const refusing: typeof herdr.run = async (input) =>
      input.argv.slice(3, 5).join(" ") === "pane split"
        ? { stdout: "", stderr: "split refused", exitCode: 1, timedOut: false }
        : herdr.run(input);
    const other = await createHerdrRunHostFactory(CONFIG, refusing).openRun({
      runId: "r2",
      cwd: "/repo",
      deadline: deadline(),
    });
    await open(other, "a");
    const b = await open(other, "b", { beside: "a", side: "right" });
    expect(b.pane?.()?.fallback).toBe("Herdr would not split a's pane: split refused");
    expect(b.pane?.()?.tab).toBe("b");
    await Promise.all([host.close(), other.close()]);
  });

  test("closing an agent closes its pane, not the tab its neighbours share", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const lead = await open(host, "lead");
    await open(host, "side", { beside: "lead", side: "right" });
    const [leadPane] = paneOf(herdr, "lead")!;
    await lead.close();
    expect(herdr.panes.has(leadPane)).toBe(false);
    expect(paneOf(herdr, "side")).toBeDefined();
    expect(calls(herdr, "tab close")).toHaveLength(0);
    await host.close();
  });

  test("a label is cut to 32 characters", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    await open(host, "k".repeat(40));
    expect(paneOf(herdr, "k".repeat(32))).toBeDefined();
    await host.close();
  });

  test("a relaunch replaces the pane in place: the old one split, then closed", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const worker = await open(host, "worker");
    await open(host, "side", { beside: "worker", side: "right" });
    const turn = await worker.start(
      { id: "one", prompt: "work", deadline: deadline() },
      { endpoint: "/private/engine.sock", operationId: "op-1" },
    );
    await turn.settled;
    const [before, old] = paneOf(herdr, "worker")!;
    await worker.set?.({ model: "sonnet" }, deadline());
    const [after, replaced] = paneOf(herdr, "worker")!;
    expect(after).not.toBe(before);
    expect(herdr.panes.has(before)).toBe(false);
    expect(replaced.tab).toBe(old.tab);
    expect(calls(herdr, "tab create")).toHaveLength(1);
    const later = await open(host, "later", { beside: "worker", side: "below" });
    expect(later.pane?.()?.beside).toBe("worker");
    expect(calls(herdr, "pane split").at(-1)?.argv[5]).toBe(after);
    await host.close();
  });
});
