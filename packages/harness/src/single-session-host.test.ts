import { describe, expect, test } from "bun:test";
import type { AgentSessionAdapter } from "./adapter";
import { createSingleSessionHostFactory } from "./single-session-host";
import { createFakeAdapter } from "./testing/fake";

const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });

describe("createSingleSessionHostFactory", () => {
  test("one run host owns every logical session and exposes only redacted snapshots", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const host = await createSingleSessionHostFactory(adapter).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    await Promise.all([
      host.openAgent({
        key: "correctness",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "fake", model: "one" },
      }),
      host.openAgent({
        key: "maintainability",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "fake", model: "two" },
      }),
    ]);

    const snapshot = host.inspect();
    expect(snapshot.state).toBe("running");
    expect(snapshot.agents.map((agent) => agent.key).sort()).toEqual([
      "correctness",
      "maintainability",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("fake-correctness");

    await host.close("done");
    expect(adapter.closed.sort()).toEqual(["correctness", "maintainability"]);
    expect(host.inspect().state).toBe("closed");
  });

  test("an activation that finishes after run close is closed and rejected", async () => {
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeBegan!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      closeBegan = resolve;
    });
    const inner = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...inner,
      async activate(request) {
        await activationGate;
        const session = await inner.activate(request);
        return {
          ...session,
          async close(reason) {
            closeBegan();
            await closeGate;
            await session.close(reason);
          },
        };
      },
    };
    const host = await createSingleSessionHostFactory(adapter).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const opening = host.openAgent({
      key: "late",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "fake", model: "fake" },
    });

    const closing = host.close("cancelled");
    releaseActivation();
    await closeStarted;
    let closeReturned = false;
    void closing.then(() => {
      closeReturned = true;
    });
    await Promise.resolve();
    expect(closeReturned).toBe(false);
    releaseClose();

    await closing;
    await expect(opening).rejects.toThrow("run host closed during activation");
    expect(inner.closed).toEqual(["late"]);
    expect(host.inspect().state).toBe("closed");
  });

  test("inspection follows working and quarantined operation state", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const adapter = createFakeAdapter({
      script: async ({ signal }) => {
        began();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const host = await createSingleSessionHostFactory(adapter).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "fake", model: "fake" },
    });
    const operationDeadline = deadline();
    const turn = await session.start(
      { id: "one", prompt: "one", deadline: operationDeadline },
      { endpoint: "/private/engine.sock", operationId: "op-1" },
    );
    await started;
    expect(host.inspect().agents[0]?.state).toBe("working");

    await turn.release("stop", { unixMilliseconds: Date.now() });
    await turn.settled;
    expect(host.inspect().agents[0]).toMatchObject({
      state: "quarantined",
      detail: "release deadline exceeded",
    });
    await expect(turn.nudge({ id: "nudge", deadline: deadline() })).rejects.toThrow("quarantined");
    await expect(
      session.start(
        { id: "two", prompt: "two", deadline: deadline() },
        { endpoint: "/private/engine.sock", operationId: "op-2" },
      ),
    ).rejects.toThrow("quarantined");
    expect(host.inspect().agents[0]?.state).toBe("quarantined");
    await host.close();
  });
  test("a start the session refuses does not leave the agent reported as working", async () => {
    const host = await createSingleSessionHostFactory(
      createFakeAdapter({ script: () => ({}) }),
    ).openRun({ runId: "run-1", cwd: "/repo", deadline: deadline() });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "fake", model: "fake" },
    });

    await expect(
      session.start(
        { id: "late", prompt: "late", deadline: { unixMilliseconds: Date.now() - 1 } },
        { endpoint: "/private/engine.sock", operationId: "op-1" },
      ),
    ).rejects.toThrow();
    expect(host.inspect().agents[0]?.state).toBe("idle");
    await host.close();
  });
});
