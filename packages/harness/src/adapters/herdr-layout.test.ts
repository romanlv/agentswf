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

  test("a pane placed and never run is closed with its agent, the workspace left open", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const idle = await open(host, "idle");
    const [paneId] = paneOf(herdr, "idle")!;
    await idle.close();
    expect(calls(herdr, "pane close").map((call) => call.argv[5])).toEqual([paneId]);
    expect(herdr.openWorkspaces()).toHaveLength(1);
    await host.close();
  });

  test("a first start that fails closes its pane; the next operation places another and runs", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    let starts = 0;
    const failingOnce: typeof herdr.run = async (input) =>
      input.argv.slice(3, 5).join(" ") === "agent start" && ++starts === 1
        ? { stdout: "", stderr: '{"error":{"code":"boom"}}', exitCode: 1, timedOut: false }
        : herdr.run(input);
    const host = await createHerdrRunHostFactory(CONFIG, failingOnce).openRun({
      runId: "r1",
      cwd: "/repo",
      deadline: deadline(),
    });
    await open(host, "lead");
    const side = await open(host, "side", { beside: "lead", side: "right" });
    const [first] = paneOf(herdr, "side")!;
    const turn = (id: string) =>
      side
        .start(
          { id, prompt: "work", deadline: deadline() },
          { endpoint: "/e.sock", operationId: id },
        )
        .then((started) => started.settled);
    await expect(turn("one")).resolves.toMatchObject({ state: "failed" });
    expect(herdr.panes.has(first)).toBe(false);
    await expect(turn("two")).resolves.toMatchObject({ state: "completed" });
    expect(calls(herdr, "pane split")).toHaveLength(2);
    expect(side.pane?.()?.beside).toBe("lead");
    await host.close();
  });

  test("a relaunch whose split fails closes the old pane, and the agent is not driven again", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    let refuse = false;
    const refusing: typeof herdr.run = async (input) =>
      refuse && input.argv.slice(3, 5).join(" ") === "pane split"
        ? { stdout: "", stderr: "no room", exitCode: 1, timedOut: false }
        : herdr.run(input);
    const host = await createHerdrRunHostFactory(CONFIG, refusing).openRun({
      runId: "r1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const worker = await open(host, "worker");
    const turn = (id: string) =>
      worker
        .start(
          { id, prompt: "work", deadline: deadline() },
          { endpoint: "/e.sock", operationId: id },
        )
        .then((started) => started.settled);
    await turn("one");
    const [old] = paneOf(herdr, "worker")!;
    refuse = true;
    await expect(worker.set?.({ model: "sonnet" }, deadline())).rejects.toThrow("no room");
    expect(herdr.panes.has(old)).toBe(false);
    await expect(turn("two")).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("pane was closed"),
    });
    await host.close();
  });
});

describe("keeping a pane", () => {
  const turn = (session: Awaited<ReturnType<typeof open>>, id: string) =>
    session
      .start({ id, prompt: "work", deadline: deadline() }, { endpoint: "/e.sock", operationId: id })
      .then((started) => started.settled);

  test("a kept pane outlives its run; the rest of the run's panes close around it", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const lead = await open(host, "lead");
    const other = await open(host, "other");
    await turn(lead, "one");
    await turn(other, "two");
    await lead.close("done", { keep: true });
    await other.close("done");
    expect(lead.pane?.()).toMatchObject({ kept: true });
    await host.close();
    expect(herdr.openWorkspaces()).toHaveLength(1);
    expect(herdr.openPanes()).toEqual([paneOf(herdr, "lead")![0]]);
    expect(calls(herdr, "workspace close")).toHaveLength(0);
  });

  test("a pane whose harness never started is closed, not kept, and says why", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const idle = await open(host, "idle");
    await idle.close("done", { keep: true });
    expect(idle.pane?.()).toMatchObject({ notKept: "its harness never started" });
    expect(paneOf(herdr, "idle")).toBeUndefined();
    await host.close();
    expect(herdr.openWorkspaces()).toEqual([]);
  });

  test("a working harness is interrupted before it is kept, and closed if it won't settle", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    let busy = false;
    const working: typeof herdr.run = async (input) => {
      const verb = input.argv.slice(3, 5).join(" ");
      if (busy && verb === "agent wait") {
        return { stdout: "", stderr: "wait timed out", exitCode: 1, timedOut: true };
      }
      if (busy && verb === "agent get") {
        return {
          stdout: JSON.stringify({ result: { agent: { agent_status: "working" } } }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return herdr.run(input);
    };
    const host = await createHerdrRunHostFactory(CONFIG, working).openRun({
      runId: "r1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const lead = await open(host, "lead");
    await turn(lead, "one");
    busy = true;
    await lead.close("done", { keep: true });
    expect(calls(herdr, "agent send-keys").map((call) => call.argv.at(-1))).toEqual(["esc"]);
    expect(lead.pane?.()?.notKept).toContain("did not settle after an interrupt");
    expect(paneOf(herdr, "lead")).toBeUndefined();
    await host.close();
  });

  test("a cancel leaves a pane that may be kept for close, and the agent runs no more", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [] });
    const host = await openRun(herdr);
    const lead = await host.openAgent({
      key: "lead",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
      keepPane: "on-failure",
    });
    const started = await lead.start(
      { id: "one", prompt: "work", deadline: deadline() },
      { endpoint: "/e.sock", operationId: "one" },
    );
    await started.release("stop", deadline());
    expect(paneOf(herdr, "lead")).toBeDefined();
    await expect(turn(lead, "two")).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("was cancelled"),
    });
    await lead.close("done", { keep: true });
    expect(lead.pane?.()?.kept).toBe(true);
    await host.close();
  });
});

describe("sessions and workspaces", () => {
  /** A Herdr per session, as `--session` picks it. */
  function sessions(...names: string[]) {
    const fakes = Object.fromEntries(
      names.map((name) => [name, createFakeHerdr({ startupBlocks: [] })]),
    ) as Record<string, FakeHerdr>;
    const run: FakeHerdr["run"] = async (input) => {
      const fake = fakes[input.argv[2]!];
      if (!fake) return { stdout: "", stderr: "no such session", exitCode: 1, timedOut: false };
      return fake.run(input);
    };
    return { fakes, run };
  }
  const labelOf = (fake: FakeHerdr, verb: "tab create" | "workspace create") =>
    calls(fake, verb).map((call) => call.argv[call.argv.indexOf("--label") + 1]);

  test("a named session holds the run's own workspace there, closed at the run's end", async () => {
    const { fakes, run } = sessions("awf", "awf-review");
    const asked: string[] = [];
    const host = await createHerdrRunHostFactory(
      { ...CONFIG, sessionFor: async (name) => void asked.push(name) },
      run,
    ).openRun({ runId: "r1", label: "awf review r1", cwd: "/repo", deadline: deadline() });
    const a = await open(host, "a", { session: "awf-review", tab: "lens" });
    const b = await open(host, "b", { session: "awf-review" });
    expect(asked).toEqual(["awf-review"]);
    expect(a.pane?.()).toEqual({ session: "awf-review", workspace: "run", tab: "lens" });
    expect(b.pane?.()?.session).toBe("awf-review");
    expect(fakes["awf-review"]!.workspaceLabels()).toEqual(["awf review r1"]);
    expect(labelOf(fakes["awf-review"]!, "tab create")).toEqual(["lens", "b"]);
    expect(fakes.awf!.openWorkspaces()).toEqual([]);
    await host.close();
    expect(fakes["awf-review"]!.openWorkspaces()).toEqual([]);
  });

  test("a session that can't be used falls back to the same workspace in the run session", async () => {
    const { fakes, run } = sessions("awf");
    const host = await createHerdrRunHostFactory(
      { ...CONFIG, sessionFor: async () => "it is not running" },
      run,
    ).openRun({ runId: "r1", label: "awf review r1", cwd: "/repo", deadline: deadline() });
    const a = await open(host, "a", { session: "work", workspace: { name: "review" } });
    expect(a.pane?.()).toEqual({
      session: "awf",
      workspace: { name: "review" },
      tab: "awf review r1 a",
      fallback: "session work can't be used: it is not running",
    });
    expect(fakes.awf!.workspaceLabels()).toEqual(["review"]);
    await host.close();
  });

  test("a named workspace is found by its label, shared: tabs labelled by run, never closed", async () => {
    const { fakes, run } = sessions("awf");
    const awf = fakes.awf!;
    await awf.run({
      argv: ["herdr", "--session", "awf", "workspace", "create", "--label", "review"],
      timeoutMs: 1,
    });
    const locks: string[] = [];
    const host = await createHerdrRunHostFactory(
      {
        ...CONFIG,
        lockWorkspace: async (session, name) => {
          locks.push(`${session}/${name}`);
          return async () => undefined;
        },
      },
      run,
    ).openRun({ runId: "r1", label: "awf review r1", cwd: "/repo", deadline: deadline() });
    const a = await open(host, "a", { workspace: { name: "review" }, tab: "lens" });
    expect(a.pane?.()).toEqual({
      session: "awf",
      workspace: { name: "review" },
      tab: "awf review r1 lens",
    });
    expect(locks).toEqual(["awf/review"]);
    expect(calls(awf, "tab create")[0]!.argv).toContain("w1");
    await a.close();
    await host.close();
    expect(awf.workspaceLabels()).toEqual(["review"]);
  });

  test("a named workspace that isn't there is made, its first pane the agent's", async () => {
    const { fakes, run } = sessions("awf");
    const awf = fakes.awf!;
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "r1",
      label: "awf review r1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const a = await open(host, "a", { workspace: { name: "review" } });
    expect(labelOf(awf, "workspace create")).toEqual(["review"]);
    expect(calls(awf, "tab create")).toHaveLength(0);
    expect(calls(awf, "tab rename").at(-1)?.argv.at(-1)).toBe("awf review r1 a");
    expect(a.pane?.()?.workspace).toEqual({ name: "review" });
    await host.close();
    expect(awf.workspaceLabels()).toEqual(["review"]);
    expect(paneOf(awf, "a")).toBeUndefined();
  });

  test('"origin" opens a tab in the operator\'s workspace, and a beside there splits it', async () => {
    const { fakes, run } = sessions("awf", "default");
    const operator = fakes.default!;
    await operator.run({
      argv: ["herdr", "--session", "default", "workspace", "create", "--label", "mine"],
      timeoutMs: 1,
    });
    const host = await createHerdrRunHostFactory(
      { ...CONFIG, origin: async () => ({ session: "default", workspaceId: "w1" }) },
      run,
    ).openRun({ runId: "r1", label: "awf review r1", cwd: "/repo", deadline: deadline() });
    const lead = await open(host, "lead", { workspace: "origin", tab: "review" });
    const side = await open(host, "side", { beside: "lead", side: "right" });
    expect(lead.pane?.()).toEqual({
      session: "default",
      workspace: "origin",
      tab: "awf review r1 review",
    });
    expect(side.pane?.()).toEqual({ session: "default", workspace: "origin", beside: "lead" });
    expect(calls(operator, "pane split")).toHaveLength(1);
    expect(fakes.awf!.openWorkspaces()).toEqual([]);
    await lead.close();
    await side.close();
    await host.close();
    expect(operator.openWorkspaces()).toEqual(["w1"]);
    expect(calls(operator, "workspace close")).toHaveLength(0);
  });

  test("an \"origin\" that can't be used falls back to the run's workspace, saying why", async () => {
    const { run } = sessions("awf");
    const host = await createHerdrRunHostFactory(
      { ...CONFIG, origin: async () => "its Herdr runs 0.9.0" },
      run,
    ).openRun({ runId: "r1", label: "awf review r1", cwd: "/repo", deadline: deadline() });
    const a = await open(host, "a", { workspace: "origin" });
    const b = await open(host, "b", { workspace: "origin" });
    expect(a.pane?.()).toEqual({
      session: "awf",
      workspace: "run",
      tab: "a",
      fallback: '"origin" can\'t be used: its Herdr runs 0.9.0',
    });
    expect(b.pane?.()?.fallback).toBe(a.pane?.()?.fallback);
    await host.close();
  });

  test("the run's end closes what it made in a shared workspace, and keeps a kept pane", async () => {
    const { fakes, run } = sessions("awf", "default");
    const operator = fakes.default!;
    await operator.run({
      argv: ["herdr", "--session", "default", "workspace", "create", "--label", "mine"],
      timeoutMs: 1,
    });
    const host = await createHerdrRunHostFactory(
      { ...CONFIG, origin: async () => ({ session: "default", workspaceId: "w1" }) },
      run,
    ).openRun({ runId: "r1", label: "awf review r1", cwd: "/repo", deadline: deadline() });
    const kept = await open(host, "kept", { workspace: "origin" });
    await open(host, "idle", { workspace: "origin" });
    await kept
      .start(
        { id: "one", prompt: "work", deadline: deadline() },
        { endpoint: "/e", operationId: "one" },
      )
      .then((turn) => turn.settled);
    await kept.close("done", { keep: true });
    await host.close();
    expect(paneOf(operator, "kept")).toBeDefined();
    expect(paneOf(operator, "idle")).toBeUndefined();
    expect(operator.openWorkspaces()).toEqual(["w1"]);
  });
});
