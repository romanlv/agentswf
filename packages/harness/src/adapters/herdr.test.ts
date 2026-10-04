import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import { HARNESSES } from "../spec";
import { codexForkHome } from "../testing/codex-rollouts";
import { createHerdrRunHostFactory, createPaneAdapter, type HerdrConfig } from "./herdr";

const CONFIG: HerdrConfig = {
  session: "wf-lab",
  workspaceLabel: "e2",
  commandTimeoutMs: 1_000,
  startRetryMs: 0,
  trustSettleMs: 0,
};

function verb(input: ProcessInput): string {
  return input.argv.slice(3, 5).join(" ");
}

/** The `--timeout` herdr is told to wait for, as distinct from the process kill that backs it. */
function askedTimeout(input: ProcessInput): number {
  const index = input.argv.indexOf("--timeout");
  return index === -1 ? Number.NaN : Number(input.argv[index + 1]);
}

function argv(calls: ProcessInput[], key: string): string[] {
  const found = calls.find((call) => verb(call) === key);
  return found ? [...found.argv] : [];
}

describe("createPaneAdapter", () => {
  const activation = {
    key: "reviewer/architecture",
    deadline: { unixMilliseconds: Date.now() + 60_000 },
    cwd: "/repo",
    execution: {
      harness: "claude",
      model: "opus",
    },
  };
  const firstBinding = {
    endpoint: "/private/engine.sock",
    operationId: "op-1",
  };
  const secondBinding = {
    endpoint: "/private/engine.sock",
    operationId: "op-2",
  };

  function operationStub() {
    const calls: ProcessInput[] = [];
    let workspaces = 0;
    let reads = 0;
    const run: RunProcess = async (input) => {
      calls.push(input);
      let result: Record<string, unknown> = {};
      if (verb(input) === "workspace create") {
        workspaces += 1;
        result = {
          root_pane: { pane_id: `w${workspaces}:p1` },
          workspace: { workspace_id: `w${workspaces}` },
        };
      } else if (verb(input) === "agent prompt") {
        result = {
          agent: {
            agent_status: "idle",
            agent_session: { kind: "id", value: "sess-1" },
          },
        };
      }
      if (verb(input) === "agent read") {
        reads += 1;
        return {
          stdout: JSON.stringify({
            session_id: "sess-1",
            result: reads === 1 ? "first" : "second",
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return {
        stdout: JSON.stringify({ result }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };
    return { run, calls };
  }

  test("does not let workspace environment overrides replace adapter-owned names", () => {
    expect(() => createPaneAdapter({ ...CONFIG, emptyEnvironment: ["PATH"] })).toThrow(
      "Herdr workspace environment is adapter-owned: PATH",
    );
  });

  test("the provider-neutral launch is translated to Herdr kind and arguments", async () => {
    for (const [harness, model, args] of [
      ["codex", "gpt-5", "-- --sandbox danger-full-access --ask-for-approval never --model gpt-5"],
      // Herdr's naming stays local when its kind differs from the executable.
      ["cursor", "", "-- --force --trust"],
    ] as const) {
      const { run, calls } = operationStub();
      const session = await createPaneAdapter(CONFIG, run).activate({
        ...activation,
        execution: { harness, model },
      });
      await (
        await session.start({ id: "t", prompt: "go", deadline: activation.deadline }, firstBinding)
      ).settled;

      const start = argv(calls, "agent start");
      expect(start[start.indexOf("--kind") + 1]).toBe(harness);
      expect(start.slice(start.indexOf("--")).join(" ")).toBe(args);
    }
  });

  test("uses a launcher-bound workspace only with the confirmed interactive launch", async () => {
    const { run, calls } = operationStub();
    const session = await createPaneAdapter(CONFIG, run).activate(activation);
    const first = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );
    await expect(first.settled).resolves.toMatchObject({
      state: "completed",
      resultEvidence: { kind: "transcript", text: "first" },
    });
    const nudge = await first.nudge({
      id: "turn-1:nudge",
      prompt: "report",
      deadline: activation.deadline,
    });
    await expect(nudge.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("interactive-resume"),
    });

    const creates = calls.filter((call) => verb(call) === "workspace create");
    expect(creates).toHaveLength(1);
    // The return channel puts nothing in the pane: the agent is told a path and runs it.
    expect(creates[0]?.argv.join(" ")).not.toContain("PATH=");
    const starts = calls.filter((call) => verb(call) === "agent start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.argv).not.toContain("-p");
    expect(starts[0]?.argv).toContain("--allowed-tools");
    expect(calls.filter((call) => verb(call) === "workspace close")).toHaveLength(1);
  });

  test("uses a valid compact Herdr name for long operation identities", async () => {
    const { run, calls } = operationStub();
    const adapter = createPaneAdapter(CONFIG, run);
    const session = await adapter.activate({
      ...activation,
      key: "Maintainability/Reviewer",
    });
    const turn = await session.start(
      {
        id: "ce97b25d-d6b0-4af9-9b30-de09abeb8401",
        prompt: "review",
        deadline: activation.deadline,
      },
      firstBinding,
    );

    await turn.settled;

    const otherSession = await adapter.activate({
      ...activation,
      key: "Maintainability/Reviewer",
    });
    const otherTurn = await otherSession.start(
      {
        id: "ce97b25d-d6b0-4af9-9b30-de09abeb8401",
        prompt: "review",
        deadline: activation.deadline,
      },
      secondBinding,
    );

    await otherTurn.settled;

    const names = calls.filter((call) => verb(call) === "agent start").map((call) => call.argv[5]);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(names[0]).toStartWith("wf-maintainability");
    expect(names[1]).not.toBe(names[0]);
  });

  test("accepts only recognized workspace trust gates when explicitly enabled", async () => {
    for (const [harness, screen, keys] of [
      [
        "claude",
        "Quick safety check: Is this a project you created or one you trust?\nYes, I trust this folder",
        ["down", "enter"],
      ],
      ["codex", "Do you trust the contents of this directory?\n1. Yes, continue", ["enter"]],
      [
        "codex",
        "  Folder access\n  /private/tmp/x\n\n  Trust this folder? Codex can read, edit, and run files here\n\n› 1. Trust and continue\n  2. Back to Agent Command Center",
        ["enter"],
      ],
      // Herdr renders the block into the pane's width, which a narrow terminal makes short.
      [
        "claude",
        " Quick safety check: Is this a project you created or one you\n trust? (Like your own" +
          " code, a well-known open source project)\n\n ❯ No, exit\n   Yes, I trust this folder",
        ["down", "enter"],
      ],
      [
        "codex",
        "  Do you trust the contents of this\n  directory? Working with untrusted\n  contents" +
          " comes with higher risk.\n\n› 1. Yes, continue\n  2. No, quit",
        ["enter"],
      ],
    ] as const) {
      const { run: baseRun, calls } = operationStub();
      let trustAccepted = false;
      const run: RunProcess = async (input) => {
        if (verb(input) === "agent start") {
          calls.push(input);
          return {
            stdout: "",
            stderr: JSON.stringify({
              error: { code: "agent_not_ready", message: "agent is blocked during startup" },
            }),
            exitCode: 1,
            timedOut: false,
          };
        }
        if (verb(input) === "agent read" && !trustAccepted) {
          calls.push(input);
          return { stdout: screen, stderr: "", exitCode: 0, timedOut: false };
        }
        if (verb(input) === "agent send-keys") trustAccepted = true;
        return baseRun(input);
      };
      const session = await createPaneAdapter(
        { ...CONFIG, acceptWorkspaceTrust: true },
        run,
      ).activate({
        ...activation,
        execution: { ...activation.execution, harness },
      });
      const turn = await session.start(
        { id: "review", prompt: "review", deadline: activation.deadline },
        firstBinding,
      );

      await expect(turn.settled).resolves.toMatchObject({ state: "completed" });
      expect(argv(calls, "agent send-keys").slice(6)).toEqual([...keys]);
      expect(argv(calls, "agent wait")).toContain("idle");
      expect(calls.filter((call) => verb(call) === "agent start")).toHaveLength(1);
    }
  });

  test("a settle it cannot afford is skipped, not spent turning the agent into a timeout", async () => {
    const { run: baseRun } = operationStub();
    let trustAccepted = false;
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start" && !trustAccepted) {
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } }),
          exitCode: 1,
          timedOut: false,
        };
      }
      if (verb(input) === "agent read" && !trustAccepted) {
        return {
          stdout: "Do you trust the contents of this directory?\n1. Yes, continue",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      if (verb(input) === "agent send-keys") trustAccepted = true;
      return baseRun(input);
    };
    const session = await createPaneAdapter(
      { ...CONFIG, acceptWorkspaceTrust: true, trustSettleMs: 5_000 },
      run,
    ).activate({ ...activation, execution: { ...activation.execution, harness: "codex" } });
    const startedAt = Date.now();
    const turn = await session.start(
      { id: "review", prompt: "review", deadline: { unixMilliseconds: Date.now() + 150 } },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "completed" });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test("a startup block is answered even when its envelope does not parse", async () => {
    const { run: baseRun, calls } = operationStub();
    let trustAccepted = false;
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start" && !trustAccepted) {
        const envelope = JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } });
        return {
          stdout: "",
          stderr: `herdr: ${envelope.slice(0, 40)}`,
          exitCode: 1,
          timedOut: false,
        };
      }
      if (verb(input) === "agent read" && !trustAccepted) {
        return {
          stdout: "Do you trust the contents of this directory?\n1. Yes, continue",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      if (verb(input) === "agent send-keys") {
        calls.push(input);
        trustAccepted = true;
      }
      return baseRun(input);
    };
    const session = await createPaneAdapter(
      { ...CONFIG, acceptWorkspaceTrust: true },
      run,
    ).activate({ ...activation, execution: { ...activation.execution, harness: "codex" } });
    const turn = await session.start(
      { id: "review", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "completed" });
    expect(calls.some((call) => verb(call) === "agent send-keys")).toBe(true);
  });

  test("the process kill outlasts every wait herdr is asked to report on", async () => {
    const { run: baseRun, calls } = operationStub();
    let trustAccepted = false;
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start") {
        calls.push(input);
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } }),
          exitCode: 1,
          timedOut: false,
        };
      }
      if (verb(input) === "agent read" && !trustAccepted) {
        calls.push(input);
        return {
          stdout:
            "Quick safety check: Is this a project you created or one you trust?\nYes, I trust this folder",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      if (verb(input) === "agent send-keys") trustAccepted = true;
      return baseRun(input);
    };
    const session = await createPaneAdapter(
      { ...CONFIG, acceptWorkspaceTrust: true },
      run,
    ).activate(activation);
    const turn = await session.start(
      { id: "review", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );
    await expect(turn.settled).resolves.toMatchObject({ state: "completed" });

    const waits = calls.filter((call) => ["agent prompt", "agent wait"].includes(verb(call)));
    expect(waits.map(verb)).toEqual(["agent wait", "agent prompt"]);
    for (const wait of waits) {
      expect(askedTimeout(wait)).toBeGreaterThan(0);
      expect(wait.timeoutMs).toBeGreaterThan(askedTimeout(wait));
    }
  });

  test("does not accept an unrecognized blocked startup screen", async () => {
    const { run: baseRun, calls } = operationStub();
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start") {
        calls.push(input);
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_not_ready" } }),
          exitCode: 1,
          timedOut: false,
        };
      }
      if (verb(input) === "agent read") {
        calls.push(input);
        return {
          stdout: "Approval required for an unrelated action",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return baseRun(input);
    };
    const session = await createPaneAdapter(
      { ...CONFIG, acceptWorkspaceTrust: true },
      run,
    ).activate(activation);
    const turn = await session.start(
      { id: "review", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("unrecognized startup block"),
    });
    expect(calls.filter((call) => verb(call) === "agent send-keys")).toHaveLength(0);
    expect(calls.filter((call) => verb(call) === "agent start")).toHaveLength(1);
  });

  test("does not accept workspace trust after the operation deadline", async () => {
    const { run: baseRun, calls } = operationStub();
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start") {
        calls.push(input);
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_not_ready" } }),
          exitCode: 1,
          timedOut: false,
        };
      }
      if (verb(input) === "agent read") {
        calls.push(input);
        await Bun.sleep(20);
        return {
          stdout:
            "Quick safety check: Is this a project you created or one you trust?\n" +
            "Yes, I trust this folder",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return baseRun(input);
    };
    const deadline = { unixMilliseconds: Date.now() + 10 };
    const session = await createPaneAdapter(
      { ...CONFIG, acceptWorkspaceTrust: true },
      run,
    ).activate({ ...activation, deadline });
    const turn = await session.start({ id: "review", prompt: "review", deadline }, firstBinding);

    await expect(turn.settled).resolves.toMatchObject({ state: "timed-out" });
    expect(calls.filter((call) => verb(call) === "agent send-keys")).toHaveLength(0);
  });

  test("does not retry a deterministic error that only mentions pane busy", async () => {
    const { run: baseRun, calls } = operationStub();
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start") {
        calls.push(input);
        return {
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "invalid_agent", message: "not agent_pane_busy" },
          }),
          exitCode: 1,
          timedOut: false,
        };
      }
      return baseRun(input);
    };
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 3 }, run).activate(
      activation,
    );
    const turn = await session.start(
      { id: "review", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "failed" });
    expect(calls.filter((call) => verb(call) === "agent start")).toHaveLength(1);
  });

  test("retries a pane-busy code the error envelope could not be parsed from", async () => {
    const { run: baseRun, calls } = operationStub();
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent start") {
        calls.push(input);
        return {
          stdout: "",
          stderr: `herdr: request failed\n{"error":{"code":"agent_pane_busy","message":"${"x".repeat(500)}`,
          exitCode: 1,
          timedOut: false,
        };
      }
      return baseRun(input);
    };
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 3 }, run).activate(
      activation,
    );
    const turn = await session.start(
      { id: "review", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await turn.settled;
    expect(calls.filter((call) => verb(call) === "agent start")).toHaveLength(3);
  });

  test("closes the operation workspace when agent start fails", async () => {
    const { run: baseRun, calls } = operationStub();
    const run: RunProcess = async (input) =>
      verb(input) === "agent start"
        ? { stdout: "", stderr: "agent_pane_busy", exitCode: 1, timedOut: false }
        : baseRun(input);
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 1 }, run).activate(
      activation,
    );
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "failed" });
    expect(calls.filter((call) => verb(call) === "workspace close")).toHaveLength(1);
  });

  test("a busy pane is not waited on after its last attempt", async () => {
    const { run: baseRun } = operationStub();
    const run: RunProcess = async (input) =>
      verb(input) === "agent start"
        ? { stdout: "", stderr: "agent_pane_busy", exitCode: 1, timedOut: false }
        : baseRun(input);

    const session = await createPaneAdapter(
      { ...CONFIG, startAttempts: 1, startRetryMs: 5_000 },
      run,
    ).activate(activation);
    const startedAt = Date.now();
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "failed" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("preserves a native Herdr timeout as timed-out", async () => {
    const { run: baseRun } = operationStub();
    const run: RunProcess = async (input) =>
      verb(input) === "agent prompt"
        ? { stdout: "", stderr: "deadline", exitCode: 137, timedOut: true }
        : baseRun(input);
    const session = await createPaneAdapter(CONFIG, run).activate(activation);
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "timed-out" });
  });

  test("preserves a Herdr agent-start timeout as timed-out", async () => {
    const { run: baseRun } = operationStub();
    const run: RunProcess = async (input) =>
      verb(input) === "agent start"
        ? { stdout: "", stderr: "start deadline", exitCode: 137, timedOut: true }
        : baseRun(input);
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 1 }, run).activate(
      activation,
    );
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "timed-out" });
  });

  test("cancellation aborts native work and finishes cleanup before returning", async () => {
    const { run: baseRun, calls } = operationStub();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return baseRun(input);
      calls.push(input);
      promptStarted();
      await new Promise<void>((resolve) =>
        input.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { stdout: "", stderr: "", exitCode: 137, timedOut: false, cancelled: true };
    };
    const session = await createPaneAdapter(CONFIG, run).activate(activation);
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );
    await started;

    await expect(turn.release("stop", activation.deadline)).resolves.toMatchObject({
      kind: "released",
    });
    await expect(turn.settled).resolves.toMatchObject({ state: "cancelled" });
    expect(calls.filter((call) => verb(call) === "workspace close")).toHaveLength(1);
    const settledCalls = calls.length;
    await session.close();
    await Promise.resolve();
    expect(calls).toHaveLength(settledCalls);
  });

  test("retains the handle after a close failure so close can retry", async () => {
    const { run: baseRun, calls } = operationStub();
    let closeAttempts = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) !== "workspace close") return baseRun(input);
      calls.push(input);
      closeAttempts += 1;
      return closeAttempts <= 2
        ? {
            stdout: "",
            stderr: `busy ${firstBinding.operationId}`,
            exitCode: 1,
            timedOut: false,
          }
        : { stdout: JSON.stringify({ result: {} }), stderr: "", exitCode: 0, timedOut: false };
    };
    const session = await createPaneAdapter(CONFIG, run).activate(activation);
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );
    expect(await turn.settled).toMatchObject({ state: "completed" });

    // The reason reaches the caller verbatim: a close failure names the workspace that would
    // otherwise be left behind.
    const firstClose = session.close();
    await expect(firstClose).rejects.toThrow(firstBinding.operationId);
    await session.close();

    expect(closeAttempts).toBe(3);
  });
});

describe("createHerdrRunHostFactory", () => {
  const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });
  const commandResult = (value: Record<string, unknown>): ProcessResult => ({
    stdout: JSON.stringify({ result: value }),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
  const binding = (operationId: string) => ({
    endpoint: "/private/engine.sock",
    operationId,
  });

  const errorResult = (code: string): ProcessResult => ({
    stdout: JSON.stringify({ error: { code, message: code } }),
    stderr: "",
    exitCode: 1,
    timedOut: false,
  });

  function hostStub(options: { exposeSession?: boolean } = {}) {
    const calls: ProcessInput[] = [];
    let panes = 1;
    const run: RunProcess = async (input) => {
      calls.push(input);
      const command = verb(input);
      if (command === "workspace create") {
        return commandResult({
          workspace: { workspace_id: "w1" },
          tab: { tab_id: "w1:t1" },
          root_pane: { pane_id: "w1:p1" },
        });
      }
      if (command === "tab create") {
        panes += 1;
        return commandResult({
          tab: { tab_id: `w1:t${panes}` },
          root_pane: { pane_id: `w1:p${panes}` },
        });
      }
      if (command === "agent prompt") {
        return commandResult({
          agent: {
            agent_status: "idle",
            ...(options.exposeSession === false
              ? {}
              : { agent_session: { kind: "id", value: `session-${input.argv[5]}` } }),
          },
        });
      }
      if (command === "agent read") {
        return {
          stdout: `${JSON.stringify({ result: {} })}\n${JSON.stringify({
            ...(options.exposeSession === false ? {} : { session_id: `session-${input.argv[5]}` }),
            result: "reviewed",
          })}`,
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return commandResult({});
    };
    return { run, calls };
  }

  test("gives each peer agent a tab of its own in one run workspace", async () => {
    const { run, calls } = hostStub();
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const [claude, codex] = await Promise.all([
      host.openAgent({
        key: "correctness",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "claude", model: "opus" },
      }),
      host.openAgent({
        key: "maintainability",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "codex", model: "gpt-5.6-sol" },
      }),
    ]);
    const first = binding("op-1");
    const second = binding("op-2");
    await Promise.all([
      (await claude.start({ id: "one", prompt: "review", deadline: deadline() }, first)).settled,
      (await codex.start({ id: "two", prompt: "review", deadline: deadline() }, second)).settled,
    ]);

    const creates = calls.filter((call) => verb(call) === "workspace create");
    const tabs = calls.filter((call) => verb(call) === "tab create");
    const starts = calls.filter((call) => verb(call) === "agent start");
    expect(creates).toHaveLength(1);
    expect(tabs.every((call) => call.argv[call.argv.indexOf("--workspace") + 1] === "w1")).toBe(
      true,
    );
    expect(tabs.map((call) => call.argv[call.argv.indexOf("--label") + 1]).sort()).toEqual([
      "correctness",
      "maintainability",
    ]);
    // With nothing to withhold there is nothing to set: the return channel needs no environment,
    // and `herdr-contract.test.ts` holds the case where credentials do have to be repeated.
    expect(tabs.every((call) => !call.argv.includes("--env"))).toBe(true);
    expect(starts.map((call) => call.argv[call.argv.indexOf("--kind") + 1]).sort()).toEqual([
      "claude",
      "codex",
    ]);

    await host.close();
    expect(calls.filter((call) => verb(call) === "workspace close")).toHaveLength(1);
  });

  test("a nudge and a later operation stay in the agent's tab, the later one once it settles", async () => {
    const { run, calls } = hostStub();
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      instructions: "You review code.",
      execution: { harness: "codex", model: "gpt-5.6-sol" },
    });
    const first = await session.start(
      { id: "one", prompt: "review", deadline: deadline() },
      binding("op-1"),
    );
    await first.settled;
    await (await first.nudge({ id: "one:nudge", prompt: "report", deadline: deadline() })).settled;
    const second = await session.start(
      { id: "two", prompt: "review again", deadline: deadline() },
      binding("op-2"),
    );

    await expect(second.settled).resolves.toMatchObject({ state: "completed" });
    const prompts = calls.filter((call) => verb(call) === "agent prompt");
    expect(prompts.map((call) => call.argv[6])).toEqual([
      "You review code.\n\nreview",
      "report",
      "review again",
    ]);
    expect(new Set(prompts.map((call) => call.argv[5])).size).toBe(1);
    // Every prompt after the first waits for the agent to settle.
    const order = calls.map(verb).filter((v) => v === "agent prompt" || v === "agent wait");
    expect(order).toEqual([
      "agent prompt",
      "agent wait",
      "agent prompt",
      "agent wait",
      "agent prompt",
    ]);
    expect(calls.filter((call) => verb(call) === "tab create")).toHaveLength(1);
    expect(calls.filter((call) => verb(call) === "agent start")).toHaveLength(1);
    expect(calls.filter((call) => verb(call) === "tab close")).toHaveLength(0);
    await host.close();
  });

  test("an answered turn is left to finish in its pane, and the next operation waits for it", async () => {
    const base = hostStub();
    let endFirst!: () => void;
    const firstEnds = new Promise<void>((resolve) => {
      endFirst = resolve;
    });
    let prompts = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent prompt" && ++prompts === 1) {
        base.calls.push(input);
        await firstEnds;
        return commandResult({ agent: { agent_status: "done" } });
      }
      return base.run(input);
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const first = await session.start(
      { id: "one", prompt: "review", deadline: deadline() },
      binding("op-1"),
    );
    await Bun.sleep(10);
    await expect(first.release("answered", deadline(), { answered: true })).resolves.toEqual({
      kind: "finishing",
    });
    const starting = session.start(
      { id: "two", prompt: "again", deadline: deadline() },
      binding("op-2"),
    );
    await Bun.sleep(10);
    expect(prompts).toBe(1);
    endFirst();
    await expect(first.settled).resolves.toMatchObject({ state: "completed" });
    await expect((await starting).settled).resolves.toMatchObject({ state: "completed" });
    expect(prompts).toBe(2);
    expect(base.calls.filter((call) => verb(call) === "tab close")).toHaveLength(0);
    await host.close();
  });

  test("an answered agent still working when the next operation must start is interrupted, in its pane", async () => {
    const base = hostStub();
    let prompts = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent prompt" && ++prompts === 1) {
        base.calls.push(input);
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { stdout: "", stderr: "cancelled", exitCode: 130, timedOut: false, cancelled: true };
      }
      if (verb(input) === "agent get") {
        base.calls.push(input);
        return commandResult({ agent: { agent_status: "working" } });
      }
      return base.run(input);
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const first = await session.start(
      { id: "one", prompt: "review", deadline: deadline() },
      binding("op-1"),
    );
    await Bun.sleep(10);
    await first.release("answered", deadline(), { answered: true });
    // Half of this one's time goes to waiting for the first, then it is stopped.
    const second = await session.start(
      { id: "two", prompt: "again", deadline: { unixMilliseconds: Date.now() + 400 } },
      binding("op-2"),
    );
    await expect(second.settled).resolves.toMatchObject({ state: "completed" });
    const keys = base.calls.filter((call) => verb(call) === "agent send-keys");
    expect(keys.map((call) => call.argv.at(-1))).toEqual(["esc"]);
    expect(base.calls.filter((call) => verb(call) === "tab close")).toHaveLength(0);
    expect(prompts).toBe(2);
    await host.close();
  });

  test("an agent still blocked when the next operation comes settles it blocked, unprompted", async () => {
    const base = hostStub();
    const run: RunProcess = async (input) =>
      verb(input) === "agent wait"
        ? commandResult({ agent: { agent_status: "blocked", agent_status_text: "approve?" } })
        : base.run(input);
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    await (
      await session.start({ id: "one", prompt: "review", deadline: deadline() }, binding("op-1"))
    ).settled;
    const second = await session.start(
      { id: "two", prompt: "again", deadline: deadline() },
      binding("op-2"),
    );

    await expect(second.settled).resolves.toMatchObject({ state: "blocked" });
    expect(base.calls.filter((call) => verb(call) === "agent prompt")).toHaveLength(1);
    await host.close();
  });

  describe("compaction", () => {
    // pi's summary is read from its own state: here a home of the test's, never the operator's.
    let piHome: string;
    const operatorPi = process.env.PI_CODING_AGENT_DIR;
    beforeAll(() => {
      piHome = mkdtempSync(join(tmpdir(), "pi-home-"));
      mkdirSync(join(piHome, "sessions", "--repo--"), { recursive: true });
      process.env.PI_CODING_AGENT_DIR = piHome;
    });
    /** pi's file for the session the stub names after the agent, holding one compaction. */
    const piSession = (calls: ProcessInput[], summary: string) => {
      const agent = calls.find((call) => verb(call) === "agent prompt")!.argv[5];
      writeFileSync(
        join(piHome, "sessions", "--repo--", `2026-10-01T00-00-00-000Z_session-${agent}.jsonl`),
        `${JSON.stringify({ type: "compaction", id: "c", summary })}\n`,
      );
    };
    afterAll(() => {
      if (operatorPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = operatorPi;
      rmSync(piHome, { recursive: true, force: true });
    });
    /** Answers the screen read with `screen`; everything else as the stub does. */
    const showing = (screen: string) => {
      const base = hostStub();
      const run: RunProcess = async (input) => {
        if (verb(input) === "agent read" && input.argv.includes("recent-unwrapped")) {
          base.calls.push(input);
          return { stdout: screen, stderr: "", exitCode: 0, timedOut: false };
        }
        return base.run(input);
      };
      return { run, calls: base.calls };
    };
    /** Answers each screen read with the next of `screens`, the last one from then on. */
    const showingInTurn = (...screens: string[]) => {
      const base = hostStub();
      let reads = 0;
      const run: RunProcess = async (input) => {
        if (verb(input) === "agent read" && input.argv.includes("recent-unwrapped")) {
          base.calls.push(input);
          const stdout = screens[Math.min(reads++, screens.length - 1)]!;
          return { stdout, stderr: "", exitCode: 0, timedOut: false };
        }
        return base.run(input);
      };
      return { run, calls: base.calls };
    };
    const opened = async (run: RunProcess, harness: "claude" | "codex" | "pi") => {
      const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline: deadline(),
      });
      const session = await host.openAgent({
        key: "worker",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness, model: "m" },
      });
      return { host, session };
    };
    const prompted = (calls: ProcessInput[]) =>
      calls.filter((call) => verb(call) === "agent prompt").map((call) => call.argv[6]);

    test("claude is typed /compact with the focus, and the screen confirms it", async () => {
      const { run, calls } = showing(
        "❯ /compact Keep the path.\n  ⎿  Compacted (ctrl+o to see full summary)\n❯ ",
      );
      const { host, session } = await opened(run, "claude");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", deadline());

      await expect(compact.settled).resolves.toMatchObject({ state: "completed", summary: "" });
      expect(prompted(calls)).toEqual(["plan", "/compact Keep the path."]);
      expect(calls.filter((call) => verb(call) === "tab create")).toHaveLength(1);
      await host.close();
    });

    test("codex is sent the focus, then a bare /compact once it settles", async () => {
      // A bare `/compact` is not echoed: the compaction shows after the focus message.
      const { run, calls } = showing(
        "› Your context is about to be compacted. For its summary: Keep the path.\n\n  Reply only: ok\n\n• ok\n\n• Context compacted · 2s\n\n› ",
      );
      const { host, session } = await opened(run, "codex");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", deadline());

      await expect(compact.settled).resolves.toMatchObject({ state: "completed", summary: "" });
      const [, focus, command] = prompted(calls);
      expect(focus).toContain("Keep the path.");
      expect(command).toBe("/compact");
      const order = calls.map(verb).filter((v) => v === "agent prompt" || v === "agent wait");
      expect(order).toEqual([
        "agent prompt",
        "agent wait",
        "agent prompt",
        "agent wait",
        "agent prompt",
      ]);
      await host.close();
    });

    test("a screen that shows no compaction after /compact fails it, and the agent goes on", async () => {
      const { run, calls } = showing(
        "❯ /compact Keep the path.\n  ⎿  Error: conversation too short\n",
      );
      const { host, session } = await opened(run, "claude");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", deadline());
      await expect(compact.settled).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining("claude shows no compaction"),
      });
      const next = await session.start(
        { id: "two", prompt: "build", deadline: deadline() },
        binding("op-2"),
      );
      await expect(next.settled).resolves.toMatchObject({ state: "completed" });
      expect(prompted(calls)).toEqual(["plan", "/compact Keep the path.", "build"]);
      await host.close();
    });

    test("pi is typed /compact with the focus, and a new compaction line confirms it", async () => {
      // pi echoes no slash command, so only a line the screen did not hold before counts.
      // Herdr sees pi idle while it compacts, so the screen is read again until it shows the end.
      const { run, calls } = showingInTurn(
        " plan\n VALVE-4944\n",
        " plan\n VALVE-4944\n",
        " plan\n VALVE-4944\n [compaction]\n Compacted from 30,993 tokens (ctrl+o to expand)\n",
      );
      const { host, session } = await opened(run, "pi");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      piSession(calls, "the path is 14 m");
      const compact = await session.compact("c-1", "Keep the path.", deadline());

      await expect(compact.settled).resolves.toMatchObject({
        state: "completed",
        summary: "the path is 14 m",
      });
      expect(prompted(calls)).toEqual(["plan", "/compact Keep the path."]);
      expect(calls.filter((call) => call.argv.includes("recent-unwrapped"))).toHaveLength(3);
      await host.close();
    });

    test("pi's second compaction, which redraws its chat, is told by its new line", async () => {
      // A compaction clears pi's chat and redraws one line for the newest; the count stays one.
      const { run } = showingInTurn(
        " [compaction]\n Compacted from 30,993 tokens\n build\n ok\n",
        " [compaction]\n Compacted from 41,207 tokens (ctrl+o to expand)\n",
      );
      const { host, session } = await opened(run, "pi");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", deadline());

      await expect(compact.settled).resolves.toMatchObject({ state: "completed" });
      await host.close();
    });

    test("pi's cancelled compaction ends the wait at once, as failed", async () => {
      const { run } = showingInTurn(" ok\n", " ok\n Error: Compaction cancelled\n");
      const { host, session } = await opened(run, "pi");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", deadline());

      await expect(compact.settled).resolves.toMatchObject({ state: "failed" });
      await host.close();
    });

    test("a focus over several lines is typed as one", async () => {
      const { run, calls } = showingInTurn(" ok\n", " ok\n Compacted from 9,000 tokens\n");
      const { host, session } = await opened(run, "pi");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      await (await session.compact("c-1", "Keep the path.\n\nDrop the rest.", deadline())).settled;

      expect(prompted(calls)).toEqual(["plan", "/compact Keep the path. Drop the rest."]);
      await host.close();
    });

    test("pi's compaction that never shows its end times out, and is interrupted", async () => {
      const { run, calls } = showingInTurn(" plan\n VALVE-4944\n");
      const { host, session } = await opened(run, "pi");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", {
        unixMilliseconds: Date.now() + 1_500,
      });

      await expect(compact.settled).resolves.toMatchObject({ state: "timed-out" });
      const keys = calls.filter((call) => verb(call) === "agent send-keys");
      expect(keys.map((call) => call.argv.at(-1))).toContain("esc");
      await host.close();
    });

    test("pi's earlier compaction on the screen does not confirm a failed one", async () => {
      const earlier = " [compaction]\n Compacted from 30,993 tokens\n build\n ok\n";
      const { run } = showingInTurn(
        earlier,
        `${earlier} Error: Compaction failed: Nothing to compact (session too small)\n`,
      );
      const { host, session } = await opened(run, "pi");
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const compact = await session.compact("c-1", "Keep the path.", deadline());

      await expect(compact.settled).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining("pi shows no compaction"),
      });
      await host.close();
    });

    test("a compaction before the agent's first turn opens no tab", async () => {
      const { run, calls } = showing("");
      const { host, session } = await opened(run, "claude");
      const compact = await session.compact("c-1", "Keep the path.", deadline());
      await expect(compact.settled).resolves.toMatchObject({
        state: "failed",
        detail: "there is nothing to compact before the first turn",
      });
      expect(calls.filter((call) => verb(call) === "tab create")).toHaveLength(0);
      await host.close();
    });
  });

  describe("set", () => {
    const opened = async (run: RunProcess, harness: "claude" | "codex" | "pi" = "claude") => {
      const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline: deadline(),
      });
      const session = await host.openAgent({
        key: "worker",
        cwd: "/repo",
        deadline: deadline(),
        instructions: "You build it.",
        execution: { harness, model: "m", effort: "low" },
      });
      return { host, session };
    };
    const starts = (calls: ProcessInput[]) => calls.filter((call) => verb(call) === "agent start");
    const turn = async (session: Awaited<ReturnType<typeof opened>>["session"], n: number) =>
      (
        await session.start(
          { id: `t${n}`, prompt: `go ${n}`, deadline: deadline() },
          binding(`op-${n}`),
        )
      ).settled;

    test("relaunches the pane's harness on its session at the new settings, once it has settled", async () => {
      const { run, calls } = hostStub();
      const { host, session } = await opened(run);
      await turn(session, 1);
      const named = calls.find((call) => verb(call) === "agent prompt")!.argv[5];
      await session.set!({ model: "m2", effort: "high" }, deadline());
      await turn(session, 2);

      const [first, second] = starts(calls);
      expect(first!.argv).toEqual(expect.arrayContaining(["--model", "m", "--effort", "low"]));
      expect(first!.argv).not.toContain("--resume");
      expect(second!.argv).toEqual(
        expect.arrayContaining([
          "--resume",
          `session-${named}`,
          "--model",
          "m2",
          "--effort",
          "high",
        ]),
      );
      expect(calls.filter((call) => verb(call) === "tab close")).toHaveLength(1);
      const order = calls.map(verb);
      const relaunched = order.lastIndexOf("agent start");
      expect(order.slice(0, relaunched)).toContain("agent wait");
      // The session already holds its instructions: the relaunched pane is not told them again.
      const typed = calls
        .filter((call) => ["agent prompt", "pane send-text"].includes(verb(call)))
        .map((call) => call.argv.join(" "));
      expect(typed.filter((line) => line.includes("You build it."))).toHaveLength(1);
      await host.close();
    });

    test("pi relaunches with its own flags, and codex's relaunch plan carries its own", async () => {
      const { run, calls } = hostStub();
      const { host, session } = await opened(run, "pi");
      await turn(session, 1);
      await session.set!({ model: "m2", effort: "high" }, deadline());
      expect(starts(calls)[1]!.argv).toEqual(
        expect.arrayContaining(["--model", "m2", "--thinking", "high"]),
      );
      await host.close();
      // A codex pane names its session to nobody; the engine's tests find it by its operation.
      expect(
        HARNESSES.codex.interactiveResume!("thread-1", { model: "m2", effort: "high" }).argv,
      ).toEqual(
        expect.arrayContaining([
          "resume",
          "thread-1",
          "-c",
          'model_reasoning_effort="high"',
          "--model",
          "m2",
        ]),
      );
    });

    test("a relaunch is a new agent in Herdr, not the name of the one it closed", async () => {
      const { run, calls } = hostStub();
      const { host, session } = await opened(run);
      await turn(session, 1);
      await session.set!({ model: "m", effort: "high" }, deadline());
      const [first, second] = starts(calls);
      expect(second!.argv[5]).not.toBe(first!.argv[5]);
      await host.close();
    });

    test("a pi pane on a fork relaunches on the fork's file, not the parent id Herdr reports", async () => {
      const { run, calls } = hostStub();
      const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline: deadline(),
      });
      const session = await host.openAgent({
        key: "worker",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "pi", model: "m" },
        continues: { harness: "pi", sessionRef: "/forks/abc/fork.jsonl" },
      });
      await turn(session, 1);
      await session.set!({ model: "m", effort: "high" }, deadline());
      expect(starts(calls)[1]!.argv).toEqual(
        expect.arrayContaining(["--session", "/forks/abc/fork.jsonl", "--thinking", "high"]),
      );
      await host.close();
    });

    test("a codex pane whose session its turn never found looks again before it relaunches", async () => {
      const { run, calls } = hostStub();
      const codex = HARNESSES.codex;
      const original = codex.findSession;
      const asked: string[] = [];
      codex.findSession = async (marker) => {
        asked.push(marker);
        return asked.length > 1 ? "thread-1" : undefined;
      };
      try {
        const { host, session } = await opened(run, "codex");
        await turn(session, 1);
        await session.set!({ model: "m", effort: "high" }, deadline());
        expect(asked).toEqual(["op-1", "op-1"]);
        expect(starts(calls)[1]!.argv).toEqual(expect.arrayContaining(["resume", "thread-1"]));
        await host.close();
      } finally {
        codex.findSession = original;
      }
    });

    test("before its first turn, the pane opens at the new settings and nothing is relaunched", async () => {
      const { run, calls } = hostStub();
      const { host, session } = await opened(run);
      await session.set!({ model: "m2", effort: "max" }, deadline());
      await turn(session, 1);

      expect(starts(calls)).toHaveLength(1);
      expect(starts(calls)[0]!.argv).toEqual(
        expect.arrayContaining(["--model", "m2", "--effort", "max"]),
      );
      await host.close();
    });

    test("a relaunch that does not start rejects, and leaves no pane to go on in", async () => {
      const base = hostStub();
      let started = 0;
      const run: RunProcess = async (input) => {
        if (verb(input) === "agent start" && started++ > 0) {
          base.calls.push(input);
          return errorResult("agent_start_failed");
        }
        return base.run(input);
      };
      const { host, session } = await opened(run);
      await turn(session, 1);

      await expect(session.set!({ effort: "high", model: "m" }, deadline())).rejects.toThrow();
      await expect(turn(session, 2)).resolves.toMatchObject({
        state: "failed",
        detail: "this agent's pane was closed, so its session cannot be continued",
      });
      await host.close();
    });
  });

  describe("fork", () => {
    /** The stub, with the harness's own fork answered as claude prints it for `/cost`. */
    const forking = (options: { exposeSession?: boolean } = {}) => {
      const base = hostStub(options);
      const run: RunProcess = async (input) => {
        if (input.argv[0] === "claude") {
          base.calls.push(input);
          return {
            stdout: JSON.stringify({ session_id: "fork-1", num_turns: 0, total_cost_usd: 0.2 }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }
        return base.run(input);
      };
      return { run, calls: base.calls };
    };
    const opened = async (run: RunProcess, extra: Record<string, unknown> = {}) => {
      const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline: deadline(),
      });
      const session = await host.openAgent({
        key: "worker",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "claude", model: "m" },
        ...extra,
      });
      return { host, session };
    };

    test("a pane parent is forked beside its pane, once its agent has settled, from the session the pane named", async () => {
      const { run, calls } = forking();
      const { host, session } = await opened(run);
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      const fork = await session.fork!(deadline());

      expect(fork).toEqual({ harness: "claude", sessionRef: "fork-1", costTotal: 0.2 });
      const forked = calls.find((call) => call.argv[0] === "claude")!;
      const named = calls.find((call) => verb(call) === "agent prompt")!.argv[5];
      expect(forked.argv).toEqual(
        expect.arrayContaining(["-p", "--resume", `session-${named}`, "--fork-session"]),
      );
      expect(forked.stdin).toBe("/cost");
      const order = calls.map((call) => (call.argv[0] === "claude" ? "fork" : verb(call)));
      expect(order.slice(order.lastIndexOf("agent wait"))).toEqual(["agent wait", "fork"]);
      await host.close();
    });

    test("a pane parent whose session is still being written is forked once it is not", async () => {
      const { run, calls } = forking();
      let reads = 0;
      const claude = HARNESSES.claude;
      const original = claude.readSessionUsage;
      claude.readSessionUsage = async () => ({ records: [], open: ++reads < 3 });
      try {
        const { host, session } = await opened(run);
        await (
          await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
        ).settled;
        await session.fork!(deadline());
        expect(reads).toBe(3);
        expect(calls.filter((call) => call.argv[0] === "claude")).toHaveLength(1);
        await host.close();
      } finally {
        claude.readSessionUsage = original;
      }
    });

    test("a codex pane that names no session is found by its operation's id, and forked from it", async () => {
      const base = hostStub({ exposeSession: false });
      const run: RunProcess = async (input) => {
        if (input.argv[0] === "codex") {
          base.calls.push(input);
          return {
            stdout: JSON.stringify({ id: 2, result: { thread: { id: "thread-2" } } }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
            answered: true,
          };
        }
        return base.run(input);
      };
      const codex = HARNESSES.codex;
      const original = codex.findSession;
      const asked: string[] = [];
      codex.findSession = async (marker) => {
        asked.push(marker);
        return "thread-1";
      };
      try {
        const { host, session } = await opened(run, {
          execution: { harness: "codex", model: "m" },
        });
        await (
          await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
        ).settled;
        const rollouts = codexForkHome();
        try {
          await expect(session.fork!(deadline())).resolves.toEqual({
            harness: "codex",
            sessionRef: "thread-2",
          });
          expect(readFileSync(rollouts.fork, "utf8")).toContain(
            '"session_id":"thread-1","id":"thread-2"',
          );
        } finally {
          rollouts.restore();
        }
        expect(asked).toEqual(["op-1"]);
        expect(base.calls.find((call) => call.argv[0] === "codex")!.stdin).toContain(
          '"threadId":"thread-1"',
        );
        await host.close();
      } finally {
        codex.findSession = original;
      }
    });

    test("a pane whose harness never named its session is not forked", async () => {
      const { run, calls } = forking({ exposeSession: false });
      const { host, session } = await opened(run);
      await (
        await session.start({ id: "one", prompt: "plan", deadline: deadline() }, binding("op-1"))
      ).settled;
      await expect(session.fork!(deadline())).rejects.toThrow(
        "its harness never named its session, so it cannot be forked",
      );
      expect(calls.some((call) => call.argv[0] === "claude")).toBe(false);
      await host.close();
    });

    test("a pane continuing a fork launches on it, and its first prompt carries its instructions", async () => {
      const { run, calls } = forking();
      const { host, session } = await opened(run, {
        instructions: "You write the tests.",
        continues: { harness: "claude", sessionRef: "fork-1" },
      });
      await (
        await session.start({ id: "one", prompt: "test", deadline: deadline() }, binding("op-1"))
      ).settled;

      const started = calls.find((call) => verb(call) === "agent start")!;
      expect(started.argv).toEqual(expect.arrayContaining(["--resume", "fork-1"]));
      // Claude shows a prompt Herdr pastes as pasted text, which it will not act on: one of
      // several lines is typed, and a line of the operator's own submits it.
      const typed = calls.find((call) => call.argv.slice(3, 5).join(" ") === "pane send-text")!;
      expect(typed.argv.at(-1)).toBe("You write the tests.\n\ntest\n\n");
      expect(calls.find((call) => verb(call) === "agent prompt")!.argv[6]).toBe(
        "Do what the text above asks.",
      );
      await host.close();
    });

    test("a pi pane continuing a fork launches on its file, whose id is its parent's", async () => {
      const { run, calls } = forking();
      const { host, session } = await opened(run, {
        execution: { harness: "pi", model: "m" },
        continues: { harness: "pi", sessionRef: "/pi/sessions/awf-forks/u/2026_parent.jsonl" },
      });
      await (
        await session.start({ id: "one", prompt: "test", deadline: deadline() }, binding("op-1"))
      ).settled;
      const started = calls.find((call) => verb(call) === "agent start")!;
      expect(started.argv).toEqual(
        expect.arrayContaining(["--session", "/pi/sessions/awf-forks/u/2026_parent.jsonl"]),
      );
      await host.close();
    });
  });

  test("the agent's own tab carries the scrubbed environment, not just the workspace", async () => {
    const { run, calls } = hostStub();
    const host = await createHerdrRunHostFactory(
      { ...CONFIG, emptyEnvironment: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
      run,
    ).openRun({ runId: "run-1", cwd: "/repo", deadline: deadline() });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    await (
      await session.start({ id: "one", prompt: "review", deadline: deadline() }, binding("op-1"))
    ).settled;

    for (const scope of ["workspace create", "tab create"] as const) {
      const emitted = argv(calls, scope);
      expect(emitted).toContain("ANTHROPIC_API_KEY=");
      expect(emitted).toContain("OPENAI_API_KEY=");
      expect(emitted.join(" ")).not.toContain("PATH=");
    }
    await host.close();
  });

  test("a host claude pane starts with its skill arguments last", async () => {
    const { run, calls } = hostStub();
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
      skills: { directory: "/run/b/.claude/skills", names: ["alpha"], sandboxed: false },
    });
    await (
      await session.start({ id: "one", prompt: "review", deadline: deadline() }, binding("op-1"))
    ).settled;
    expect(argv(calls, "agent start").slice(-6)).toEqual([
      "--model",
      "opus",
      "--setting-sources",
      "project,local",
      "--add-dir",
      "/run/b",
    ]);
    await host.close();
  });

  test("a host codex with skills starts in a tab carrying its own home", async () => {
    const { run, calls } = hostStub();
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "codex", model: "gpt-5.6-sol" },
      skills: {
        directory: "/run/b/home/skills",
        names: ["alpha"],
        ownHome: "/run/b/home",
        sandboxed: false,
      },
    });
    await (
      await session.start({ id: "one", prompt: "review", deadline: deadline() }, binding("op-1"))
    ).settled;

    const tab = argv(calls, "tab create");
    expect(tab[tab.indexOf("CODEX_HOME=/run/b/home") - 1]).toBe("--env");
    const start = argv(calls, "agent start");
    const at = start.indexOf("skills.bundled.enabled=false");
    expect(start[at - 1]).toBe("-c");
    await host.close();
  });

  test("releasing a turn while its tab is still being created reports it cancelled", async () => {
    const { run: base } = hostStub();
    let creating!: () => void;
    const creationStarted = new Promise<void>((resolve) => {
      creating = resolve;
    });
    const run: RunProcess = async (input) => {
      if (verb(input) !== "tab create") return base(input);
      creating();
      await new Promise<void>((resolve) =>
        input.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        stdout: "",
        stderr: "process cancelled",
        exitCode: 1,
        timedOut: false,
        cancelled: true,
      };
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const turn = await session.start(
      { id: "one", prompt: "review", deadline: deadline() },
      binding("op-1"),
    );
    await creationStarted;

    await expect(turn.release("stop", deadline())).resolves.toMatchObject({
      kind: "released",
      outcome: { state: "cancelled" },
    });
    await host.close();
  });

  test("a blocked or unknown generation keeps its own state", async () => {
    for (const terminalState of ["blocked", "unknown"] as const) {
      const base = hostStub();
      const run: RunProcess = async (input) => {
        if (verb(input) !== "agent prompt") return base.run(input);
        base.calls.push(input);
        return commandResult({
          agent: { agent_status: terminalState, agent_status_text: "stuck" },
        });
      };
      const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
        runId: `run-${terminalState}`,
        cwd: "/repo",
        deadline: deadline(),
      });
      const session = await host.openAgent({
        key: "reviewer",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "claude", model: "opus" },
      });
      const turn = await session.start(
        { id: "one", prompt: "one", deadline: deadline() },
        binding("op-1"),
      );

      await expect(turn.settled).resolves.toMatchObject({
        state: terminalState === "blocked" ? "blocked" : "failed",
      });
      await host.close();
    }
  });

  test("release aborts an active peer and closes its authority-bearing pane", async () => {
    const base = hostStub();
    let promptEntered!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      promptEntered = resolve;
    });
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return base.run(input);
      base.calls.push(input);
      promptEntered();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        stdout: "",
        stderr: "cancelled",
        exitCode: 130,
        timedOut: false,
        cancelled: true,
      };
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const turn = await session.start(
      { id: "one", prompt: "review", deadline: deadline() },
      binding("op-1"),
    );
    await promptStarted;

    await expect(turn.release("stop", deadline())).resolves.toMatchObject({
      kind: "released",
      outcome: { state: "cancelled" },
    });
    expect(base.calls.filter((call) => verb(call) === "tab close")).toHaveLength(1);
    for (const id of ["op-2", "op-3"] as const) {
      const later = await session.start({ id, prompt: "again", deadline: deadline() }, binding(id));
      await expect(later.settled).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining("pane was closed"),
      });
    }
    expect(base.calls.filter((call) => verb(call) === "tab create")).toHaveLength(1);
    await host.close();
  });

  test("a success racing cancellation cannot make the cancelled generation resumable", async () => {
    const base = hostStub();
    let promptEntered!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      promptEntered = resolve;
    });
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return base.run(input);
      base.calls.push(input);
      promptEntered();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return commandResult({
        agent: {
          agent_status: "idle",
          agent_session: { kind: "id", value: "racing-session" },
        },
      });
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-race",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const turn = await session.start(
      { id: "one", prompt: "review", deadline: deadline() },
      binding("op-1"),
    );
    await promptStarted;
    await turn.release("stop", deadline());

    const later = await session.start(
      { id: "two", prompt: "again", deadline: deadline() },
      binding("op-2"),
    );
    await expect(later.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("pane was closed"),
    });
    expect(base.calls.filter((call) => verb(call) === "tab create")).toHaveLength(1);
    await host.close();
  });

  test("whole-workspace cleanup is idempotent and retries a failed close", async () => {
    const base = hostStub();
    let closeAttempts = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) === "workspace close") {
        base.calls.push(input);
        closeAttempts += 1;
        return closeAttempts === 1
          ? { stdout: "", stderr: "workspace busy", exitCode: 1, timedOut: false }
          : commandResult({});
      }
      return base.run(input);
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });

    await expect(host.close()).rejects.toThrow("Herdr run host cleanup failed");
    await host.close();
    await host.close();
    expect(closeAttempts).toBe(2);
    expect(host.inspect().state).toBe("closed");
  });

  test("partial host acquisition surfaces a failed workspace rollback", async () => {
    const calls: ProcessInput[] = [];
    const run: RunProcess = async (input) => {
      calls.push(input);
      if (verb(input) === "workspace create") {
        return commandResult({
          workspace: { workspace_id: "w1" },
          tab: { tab_id: "w1:t1" },
        });
      }
      if (verb(input) === "workspace close") {
        return { stdout: "", stderr: "workspace busy", exitCode: 1, timedOut: false };
      }
      throw new Error(`unexpected command: ${verb(input)}`);
    };

    // Opened at its first tab, not with the host.
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    expect(calls).toEqual([]);
    await expect(
      host.openAgent({
        key: "reviewer",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "claude", model: "opus" },
      }),
    ).rejects.toThrow("acquisition and cleanup failed");
    expect(calls.map(verb)).toEqual(["workspace create", "workspace close"]);
  });
  async function stalledReviewer(run: RunProcess, operationMs: number) {
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const turn = await session.start(
      { id: "one", prompt: "review", deadline: { unixMilliseconds: Date.now() + operationMs } },
      binding("op-1"),
    );
    return { host, turn };
  }

  /**
   * Herdr accepts the submission before the stall is reported, so the turn may be running. E2
   * measured the nudge recovering silent turns, but a nudge here would be a second prompt into a
   * live agent, and settling would close the result slot under it.
   */
  test("a stall waits the operation out instead of settling or closing the pane", async () => {
    const base = hostStub();
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return base.run(input);
      base.calls.push(input);
      return errorResult("agent_prompt_stalled");
    };
    const { host, turn } = await stalledReviewer(run, 150);
    const startedAt = Date.now();

    await expect(turn.settled).resolves.toMatchObject({
      state: "timed-out",
      detail: "operation deadline exceeded after a stalled prompt observation",
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(base.calls.filter((call) => verb(call) === "agent prompt")).toHaveLength(1);
    // The agent may still be working, so its pane and authority outlive the outcome; only the
    // engine's release or the run's cleanup takes them away.
    expect(base.calls.filter((call) => verb(call) === "tab close")).toHaveLength(0);
    await host.close();
  });

  test("a fatal prompt error that merely quotes the stall code still fails at once", async () => {
    const base = hostStub();
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return base.run(input);
      base.calls.push(input);
      // The prompt argv carries workflow-authored text, and this story's own reviewers are told
      // about `agent_prompt_stalled`; a usage error echoing it back must not read as a stall.
      return {
        stdout: "",
        stderr:
          'error: unexpected argument\n  herdr agent prompt wf-x "explain agent_prompt_stalled"',
        exitCode: 2,
        timedOut: false,
      };
    };
    const { host, turn } = await stalledReviewer(run, 60_000);
    const startedAt = Date.now();

    await expect(turn.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("unexpected argument"),
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await host.close();
  });

  test("a prompt failure Herdr does not call a stall still fails the operation", async () => {
    const base = hostStub();
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return base.run(input);
      base.calls.push(input);
      return errorResult("agent_blocked");
    };
    const { host, turn } = await stalledReviewer(run, 60_000);

    await expect(turn.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("agent_blocked"),
    });
    await host.close();
  });

  test("an operation whose tab never opened does not consume the agent", async () => {
    const base = hostStub();
    let splits = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) !== "tab create") return base.run(input);
      base.calls.push(input);
      splits += 1;
      return splits === 1
        ? errorResult("pane_split_failed")
        : commandResult({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "reviewer",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    await expect(
      (await session.start({ id: "one", prompt: "review", deadline: deadline() }, binding("op-1")))
        .settled,
    ).resolves.toMatchObject({ state: "failed", detail: expect.stringContaining("tab create") });

    const second = await session.start(
      { id: "two", prompt: "review", deadline: deadline() },
      binding("op-2"),
    );
    await expect(second.settled).resolves.toMatchObject({ state: "completed" });
    expect(splits).toBe(2);
    await host.close();
  });
});
