import { describe, expect, test } from "bun:test";
import type { AgentSessionAdapter } from "./adapter";
import { createHeadlessAdapter } from "./adapters/direct-process";
import { createPaneAdapter } from "./adapters/herdr";
import type { RunProcess } from "./command";
import { createFakeAdapter } from "./testing/fake";

const binding = {
  endpoint: "/private/engine.sock",
  operationId: "operation-1",
};

function headless(): AgentSessionAdapter {
  const run: RunProcess = async () => ({
    stdout: JSON.stringify({ session_id: "native-1", result: "done" }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
  return createHeadlessAdapter({ turnTimeoutMs: 10_000 }, run);
}

function pane(): AgentSessionAdapter {
  const run: RunProcess = async (input) => {
    const command = input.argv.slice(3, 5).join(" ");
    return result(
      command === "workspace create"
        ? {
            root_pane: { pane_id: "w1:p1" },
            workspace: { workspace_id: "w1" },
          }
        : command === "agent prompt"
          ? { agent: { agent_status: "idle", agent_session: { value: "native-1" } } }
          : {},
      command === "agent read"
        ? JSON.stringify({ session_id: "native-1", result: "done" })
        : undefined,
    );
  };
  return createPaneAdapter(
    {
      session: "test",
      workspaceLabel: "conformance",
      commandTimeoutMs: 1_000,
      settleTimeoutMs: 1_000,
      startRetryMs: 0,
    },
    run,
  );
}

function result(value: Record<string, unknown>, stdout?: string) {
  return {
    stdout: stdout ?? JSON.stringify({ result: value }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

const implementations: ReadonlyArray<{
  name: string;
  harness: string;
  create(): AgentSessionAdapter;
}> = [
  {
    name: "fake",
    harness: "fake",
    create: () => createFakeAdapter({ script: () => ({ sessionRef: "native-1" }) }),
  },
  { name: "headless", harness: "claude", create: headless },
  { name: "pane", harness: "claude", create: pane },
];

describe("AgentSessionAdapter conformance", () => {
  for (const implementation of implementations) {
    test(`${implementation.name}: lifecycle and authority invariants`, async () => {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const session = await implementation.create().activate({
        key: `conformance/${implementation.name}`,
        deadline,
        cwd: "/repo",
        execution: {
          harness: implementation.harness,
          model: "test",
        },
      });
      const turn = await session.start({ id: "turn-1", prompt: "work", deadline }, binding);

      await expect(turn.settled).resolves.toMatchObject({ state: "completed" });
      await expect(session.status()).resolves.toEqual({ state: "idle" });
      await expect(
        session.start({ id: "turn-2", prompt: "again", deadline }, binding),
      ).rejects.toThrow("already been used");
      await session.close();
      await expect(session.status()).resolves.toEqual({ state: "missing" });
    });
  }
});
