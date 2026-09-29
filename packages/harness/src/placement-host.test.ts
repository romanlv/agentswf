import { describe, expect, test } from "bun:test";
import type { AgentPlacement } from "@agentswf/contract/workflow";
import type { AgentRunHost, AgentRunHostFactory } from "./adapter";
import { createPlacementHostFactory } from "./placement-host";
import { createSingleSessionHostFactory } from "./single-session-host";
import { createFakeAdapter } from "./testing/fake";
import type { SessionAccounting } from "./usage/accounting";

const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });
const spec = { runId: "run-1", cwd: "/repo", deadline: deadline() };

function side(placement: AgentPlacement, options: { closeError?: string } = {}) {
  const adapter = createFakeAdapter({ script: () => ({}) });
  const opened: AgentRunHost[] = [];
  const closed: string[] = [];
  const accounting: SessionAccounting = {
    pollMs: 1_000,
    stalledMs: 10_000,
    statusMs: 10_000,
    read: async () => ({ records: [], open: placement === "pane" }),
    billing: async () => (placement === "pane" ? "subscription" : "metered"),
  };
  const inner = createSingleSessionHostFactory(adapter, accounting);
  const factory: AgentRunHostFactory = {
    accounting,
    async openRun(request) {
      const host = await inner.openRun(request);
      const wrapped: AgentRunHost = {
        ...host,
        async close(reason) {
          closed.push(reason ?? "");
          if (options.closeError) throw new Error(options.closeError);
          await host.close(reason);
        },
      };
      opened.push(wrapped);
      return wrapped;
    },
  };
  return { factory, adapter, opened, closed };
}

const open = (host: AgentRunHost, key: string, placement?: AgentPlacement) =>
  host.openAgent({
    key,
    cwd: "/repo",
    deadline: deadline(),
    execution: { harness: "fake", model: "m", ...(placement ? { placement } : {}) },
  });

describe("createPlacementHostFactory", () => {
  test("sends each agent to its placement's host, opening a side only when first needed", async () => {
    const pane = side("pane");
    const headless = side("headless");
    const host = await createPlacementHostFactory({
      pane: pane.factory,
      headless: headless.factory,
    }).openRun(spec);
    expect(pane.opened).toHaveLength(0);
    expect(headless.opened).toHaveLength(0);

    await open(host, "a", "headless");
    await open(host, "b", "headless");
    expect(pane.opened).toHaveLength(0);
    expect(headless.opened).toHaveLength(1);
    await open(host, "c");
    expect(pane.opened).toHaveLength(1);

    expect(headless.adapter.activations.map((activation) => activation.key)).toEqual(["a", "b"]);
    expect(pane.adapter.activations.map((activation) => activation.key)).toEqual(["c"]);
    expect(host.inspect()).toMatchObject({ state: "running" });
    expect(
      host
        .inspect()
        .agents.map((agent) => agent.key)
        .sort(),
    ).toEqual(["a", "b", "c"]);

    await host.close("done");
    expect([pane.closed, headless.closed]).toEqual([["done"], ["done"]]);
    expect(host.inspect().state).toBe("closed");
    await expect(open(host, "d", "headless")).rejects.toThrow("run host is closed");
  });

  test("a run with only headless agents never opens the pane host", async () => {
    const pane = side("pane");
    const headless = side("headless");
    const host = await createPlacementHostFactory({
      pane: pane.factory,
      headless: headless.factory,
    }).openRun(spec);
    await open(host, "a", "headless");
    await host.close();
    expect(pane.opened).toHaveLength(0);
    expect(pane.closed).toHaveLength(0);
  });

  test("close waits for a side still opening and closes it; nothing opens after close", async () => {
    const headless = side("headless");
    let letPaneOpen!: () => void;
    const paneReady = new Promise<void>((resolve) => {
      letPaneOpen = resolve;
    });
    const pane = side("pane");
    let paneOpens = 0;
    const heldPane: AgentRunHostFactory = {
      async openRun(request) {
        paneOpens += 1;
        await paneReady;
        return pane.factory.openRun(request);
      },
    };
    const host = await createPlacementHostFactory({
      pane: heldPane,
      headless: headless.factory,
    }).openRun(spec);
    const agent = open(host, "a");
    const closing = host.close("done");
    letPaneOpen();
    await expect(agent).rejects.toThrow("run host closed during activation");
    await closing;
    expect(pane.closed).toEqual(["done"]);
    expect(host.inspect().state).toBe("closed");

    // An all-headless run that has closed must not open a workspace for a late pane agent.
    const late = await createPlacementHostFactory({
      pane: heldPane,
      headless: headless.factory,
    }).openRun(spec);
    await open(late, "b", "headless");
    await late.close();
    await expect(open(late, "c")).rejects.toThrow("run host is closed");
    expect(paneOpens).toBe(1);
  });

  test("a failed close is reported and can be retried", async () => {
    const pane = side("pane", { closeError: "workspace stuck" });
    const headless = side("headless");
    const host = await createPlacementHostFactory({
      pane: pane.factory,
      headless: headless.factory,
    }).openRun(spec);
    await open(host, "a");
    await open(host, "b", "headless");
    await expect(host.close()).rejects.toThrow("run host cleanup failed");
    expect(host.inspect().state).toBe("closing");
    expect(headless.closed).toHaveLength(1);
    await expect(host.close()).rejects.toThrow("run host cleanup failed");
    expect(pane.closed).toHaveLength(2);
  });

  test("a side that fails to open fails only its agents, and holds nothing to close", async () => {
    const headless = side("headless");
    const pane: AgentRunHostFactory = {
      openRun: async () => {
        throw new Error("herdr is not running");
      },
    };
    const host = await createPlacementHostFactory({ pane, headless: headless.factory }).openRun(
      spec,
    );
    await expect(open(host, "a")).rejects.toThrow("herdr is not running");
    await open(host, "b", "headless");
    await host.close();
    expect(host.inspect().state).toBe("closed");
  });

  test("usage is read and billed by the side that ran the agent", async () => {
    const pane = side("pane");
    const headless = side("headless");
    const accounting = createPlacementHostFactory({
      pane: pane.factory,
      headless: headless.factory,
    }).accounting!;
    const inPane = { harness: "fake", model: "m" };
    const inProcess = { ...inPane, placement: "headless" as const };

    expect(await accounting.billing(inPane, [])).toBe("subscription");
    expect(await accounting.billing(inProcess, [])).toBe("metered");
    expect((await accounting.read(inPane, ["s"], "/repo"))?.open).toBe(true);
    expect((await accounting.read(inProcess, ["s"], "/repo"))?.open).toBe(false);
  });
});
