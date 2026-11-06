import { describe, expect, test } from "bun:test";
import type { AgentSessionAdapter } from "./adapter";
import { createHeadlessAdapter } from "./adapters/direct-process";
import { createHerdrRunHostFactory } from "./adapters/herdr";
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
  return createHeadlessAdapter({}, run);
}

/** A run host's agent, which opens its pane at its first turn as each run's agents do. */
function pane(): Pick<AgentSessionAdapter, "activate"> {
  let panes = 0;
  const run: RunProcess = async (input) => {
    const command = input.argv.slice(3, 5).join(" ");
    if (command === "workspace create" || command === "tab create") {
      panes += 1;
      return result({
        workspace: { workspace_id: "w1" },
        tab: { tab_id: `w1:t${panes}` },
        root_pane: { pane_id: `w1:p${panes}` },
      });
    }
    return result(
      command === "agent prompt"
        ? { agent: { agent_status: "idle", agent_session: { value: "native-1" } } }
        : {},
      command === "agent read"
        ? JSON.stringify({ session_id: "native-1", result: "done" })
        : undefined,
    );
  };
  const host = createHerdrRunHostFactory(
    { session: "test", workspaceLabel: "conformance", commandTimeoutMs: 1_000, startRetryMs: 0 },
    run,
  ).openRun({
    runId: "conformance",
    cwd: "/repo",
    deadline: { unixMilliseconds: Date.now() + 60_000 },
  });
  return { activate: async (request) => (await host).openAgent(request) };
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
  create(): Pick<AgentSessionAdapter, "activate">;
}> = [
  {
    name: "fake",
    harness: "fake",
    create: () => createFakeAdapter({ script: () => ({ sessionRef: "native-1" }) }),
  },
  { name: "headless", harness: "claude", create: headless },
  { name: "pane", harness: "pi", create: pane },
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
          ...(implementation.name === "headless"
            ? { placement: "headless" as const, metered: true as const }
            : {}),
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
