import { describe, expect, test } from "bun:test";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import type { Step } from "../types";
import { createHerdrRunHostFactory, createPaneAdapter, type HerdrConfig } from "./herdr";
import { createHerdrAdapter } from "./herdr-legacy";

const CONFIG: HerdrConfig = {
  session: "wf-lab",
  workspaceLabel: "e2",
  commandTimeoutMs: 1_000,
  settleTimeoutMs: 60_000,
  binDir: "/wf/bin",
  startRetryMs: 0,
  trustSettleMs: 0,
};

const STEP: Step = { prompt: "count the e's", harness: "claude", backend: "pane" };
const CALL = { runDir: "/runs/r", callId: "c1" };

function verb(input: ProcessInput): string {
  return input.argv.slice(3, 5).join(" ");
}

function stub(answers: Record<string, unknown>): { run: RunProcess; calls: ProcessInput[] } {
  const calls: ProcessInput[] = [];
  const run: RunProcess = async (input) => {
    calls.push(input);
    const result: ProcessResult = {
      stdout: JSON.stringify({ result: answers[verb(input)] ?? {} }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    return result;
  };
  return { run, calls };
}

const OPEN = {
  "workspace create": {
    root_pane: { pane_id: "w1:p2" },
    workspace: { workspace_id: "w1" },
  },
  "agent start": { agent: { name: "wf-c1" } },
};

/** The `--timeout` herdr is told to wait for, as distinct from the process kill that backs it. */
function askedTimeout(input: ProcessInput): number {
  const index = input.argv.indexOf("--timeout");
  return index === -1 ? Number.NaN : Number(input.argv[index + 1]);
}

function argv(calls: ProcessInput[], key: string): string[] {
  const found = calls.find((call) => verb(call) === key);
  return found ? [...found.argv] : [];
}

describe("createHerdrAdapter", () => {
  test("the call id reaches the agent through the pane environment", async () => {
    const { run, calls } = stub(OPEN);

    await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    const created = argv(calls, "workspace create");
    expect(created).toContain("WF_RUN=/runs/r");
    expect(created).toContain("WF_CALL=c1");
    expect(created.join(" ")).toContain("PATH=/wf/bin:");
  });

  test("forces selected inherited environment variables empty in the workspace", async () => {
    const { run, calls } = stub(OPEN);

    await createHerdrAdapter(
      { ...CONFIG, emptyEnvironment: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
      run,
    ).open(STEP, CALL);

    const created = argv(calls, "workspace create");
    expect(created).toContain("ANTHROPIC_API_KEY=");
    expect(created).toContain("ANTHROPIC_BASE_URL=");
  });

  test("does not let workspace environment overrides replace adapter-owned names", () => {
    expect(() => createPaneAdapter({ ...CONFIG, emptyEnvironment: ["WF_CALL"] })).toThrow(
      "Herdr workspace environment is adapter-owned: WF_CALL",
    );
  });

  test("the provider-neutral launch is translated to Herdr kind and arguments", async () => {
    const { run, calls } = stub(OPEN);

    await createHerdrAdapter(CONFIG, run).open({ ...STEP, harness: "codex", model: "gpt-5" }, CALL);

    const start = argv(calls, "agent start");
    expect(start[start.indexOf("--kind") + 1]).toBe("codex");
    expect(start.slice(start.indexOf("--")).join(" ")).toBe(
      "-- --sandbox danger-full-access --ask-for-approval never --model gpt-5",
    );
  });

  test("Herdr naming stays local when its kind differs from the executable", async () => {
    const { run, calls } = stub(OPEN);

    await createHerdrAdapter(CONFIG, run).open({ ...STEP, harness: "cursor" }, CALL);

    const start = argv(calls, "agent start");
    expect(start[start.indexOf("--kind") + 1]).toBe("cursor");
    expect(start.slice(start.indexOf("--")).join(" ")).toBe("-- --force");
  });

  /** E1 saw `agent_pane_busy` on 10 of 24 starts; without the retry every batch loses its first. */
  test("a pane that is not yet at its shell prompt is retried, not abandoned", async () => {
    const calls: ProcessInput[] = [];
    let starts = 0;
    const run: RunProcess = async (input) => {
      calls.push(input);
      if (verb(input) === "agent start") {
        starts += 1;
        if (starts === 1) {
          return { stdout: "", stderr: "agent_pane_busy", exitCode: 1, timedOut: false };
        }
      }
      return {
        stdout: JSON.stringify({ result: OPEN[verb(input) as keyof typeof OPEN] ?? {} }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };

    await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect(starts).toBe(2);
  });

  test("a pane that stays busy fails the call and takes its workspace with it", async () => {
    const calls: ProcessInput[] = [];
    const run: RunProcess = async (input) => {
      calls.push(input);
      if (verb(input) === "agent start") {
        return { stdout: "", stderr: "agent_pane_busy", exitCode: 1, timedOut: false };
      }
      return {
        stdout: JSON.stringify({ result: OPEN[verb(input) as keyof typeof OPEN] ?? {} }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };

    await expect(
      createHerdrAdapter({ ...CONFIG, startAttempts: 3 }, run).open(STEP, CALL),
    ).rejects.toThrow("agent start failed after 3: agent_pane_busy");
    expect(argv(calls, "workspace close")).toContain("w1");
  });

  test("a prompt is submitted and waited on in one command, timed in milliseconds", async () => {
    const { run, calls } = stub({ ...OPEN, "agent prompt": { agent: { agent_status: "idle" } } });
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect(await session.prompt("go")).toEqual({ state: "idle", detail: "idle" });
    const prompt = argv(calls, "agent prompt");
    // Positional text and a millisecond timeout: `--text` and `60s` are both rejected by Herdr.
    expect(prompt[5]).toBe("wf-c1");
    expect(prompt[6]).toBe("go");
    expect(prompt).toContain("--wait");
    expect(prompt[prompt.indexOf("--timeout") + 1]).toBe("60000");
  });

  test("the harness's own session id is carried out of Herdr's nested shape", async () => {
    const { run } = stub({
      ...OPEN,
      "agent prompt": {
        agent: { agent_status: "idle", agent_session: { kind: "id", value: "sess-9" } },
      },
    });
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect((await session.prompt("go")).sessionRef).toBe("sess-9");
  });

  test("a status Herdr reports that we do not know is unknown, never done", async () => {
    const { run } = stub({ ...OPEN, "agent prompt": { agent: { agent_status: "compacting" } } });
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect((await session.prompt("go")).state).toBe("unknown");
  });

  test("a Herdr failure during a prompt is unknown, not a settled turn", async () => {
    const run: RunProcess = async (input) =>
      verb(input) === "agent prompt"
        ? { stdout: "", stderr: "server_not_running", exitCode: 1, timedOut: false }
        : {
            stdout: JSON.stringify({ result: OPEN[verb(input) as keyof typeof OPEN] ?? {} }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect(await session.prompt("go")).toEqual({
      state: "unknown",
      detail: "server_not_running",
    });
  });

  test("the terminal read is the pane's own text, not a JSON envelope", async () => {
    const run: RunProcess = async (input) =>
      verb(input) === "agent read"
        ? { stdout: "<<<WF_RESULT\n{}\nWF_RESULT>>>\n", stderr: "", exitCode: 0, timedOut: false }
        : {
            stdout: JSON.stringify({ result: OPEN[verb(input) as keyof typeof OPEN] ?? {} }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect(await session.transcript()).toContain("<<<WF_RESULT");
  });

  test("a pane that cannot be read yields no transcript rather than a guess", async () => {
    const run: RunProcess = async (input) =>
      verb(input) === "agent read"
        ? { stdout: "", stderr: "agent_not_found", exitCode: 1, timedOut: false }
        : {
            stdout: JSON.stringify({ result: OPEN[verb(input) as keyof typeof OPEN] ?? {} }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    expect(await session.transcript()).toBeNull();
  });

  test("closing the session closes the workspace it opened", async () => {
    const { run, calls } = stub(OPEN);
    const session = await createHerdrAdapter(CONFIG, run).open(STEP, CALL);

    await session.close();

    expect(argv(calls, "workspace close")).toEqual([
      "herdr",
      "--session",
      "wf-lab",
      "workspace",
      "close",
      "w1",
    ]);
  });

  test("a workspace that never opened fails the call instead of prompting nothing", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "session_not_running",
      exitCode: 1,
      timedOut: false,
    });

    await expect(createHerdrAdapter(CONFIG, run).open(STEP, CALL)).rejects.toThrow(
      "workspace create failed: session_not_running",
    );
  });
});

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

  test("a nudge stays in its tab and a later operation is refused, not resumed", async () => {
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

    await expect(second.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("one operation per agent"),
    });
    expect(calls.filter((call) => verb(call) === "agent prompt")).toHaveLength(2);
    expect(calls.filter((call) => verb(call) === "tab create")).toHaveLength(1);
    expect(calls.filter((call) => verb(call) === "agent start")).toHaveLength(1);
    expect(calls.every((call) => !call.argv.includes("resume"))).toBe(true);
    await host.close();
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
      skills: { directory: "/run/b/home/skills", names: ["alpha"], home: "/run/b/home" },
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

  test("every later operation on an agent is refused without opening a tab", async () => {
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
    });
    await (
      await session.start({ id: "one", prompt: "review", deadline: deadline() }, binding("op-1"))
    ).settled;
    const second = await session.start(
      { id: "two", prompt: "again", deadline: deadline() },
      binding("op-2"),
    );

    await expect(second.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("one operation per agent"),
    });
    const third = await session.start(
      { id: "three", prompt: "again", deadline: deadline() },
      binding("op-3"),
    );
    await expect(third.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("one operation per agent"),
    });
    expect(calls.filter((call) => verb(call) === "tab create")).toHaveLength(1);
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
        detail: expect.stringContaining("one operation per agent"),
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
      detail: expect.stringContaining("one operation per agent"),
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
