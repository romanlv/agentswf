import { describe, expect, test } from "bun:test";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import type { Step } from "../types";
import {
  createHerdrAdapter,
  createHerdrRunHostFactory,
  createPaneAdapter,
  type HerdrConfig,
} from "./herdr";

const CONFIG: HerdrConfig = {
  session: "wf-lab",
  workspaceLabel: "e2",
  commandTimeoutMs: 1_000,
  settleTimeoutMs: 60_000,
  binDir: "/wf/bin",
  startRetryMs: 0,
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

  test("does not let workspace environment overrides replace adapter authority", () => {
    expect(() => createPaneAdapter({ ...CONFIG, emptyEnvironment: ["WF_CAPABILITY"] })).toThrow(
      "Herdr workspace environment is adapter-owned: WF_CAPABILITY",
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
    capability: "A".repeat(43),
  };
  const secondBinding = {
    endpoint: "/private/engine.sock",
    operationId: "op-2",
    capability: "B".repeat(43),
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
          stdout: JSON.stringify({ session_id: "sess-1", result: reads === 1 ? "first" : "second" }),
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

  test("uses a capability-bound workspace only with the confirmed interactive launch", async () => {
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
    const nudge = await first.nudge(
      { id: "turn-1:nudge", prompt: "report", deadline: activation.deadline },
    );
    await expect(nudge.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("interactive-resume"),
    });

    const creates = calls.filter((call) => verb(call) === "workspace create");
    expect(creates).toHaveLength(1);
    // Herdr 0.8.2 exposes workspace environment only through `--env KEY=VALUE` arguments.
    expect(creates[0]?.argv).toContain(`WF_CAPABILITY=${firstBinding.capability}`);
    expect(calls.filter((call) => verb(call) !== "workspace create").flatMap((call) => call.argv))
      .not.toContain(`WF_CAPABILITY=${firstBinding.capability}`);
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

    const names = calls
      .filter((call) => verb(call) === "agent start")
      .map((call) => call.argv[5]);
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
      [
        "codex",
        "Do you trust the contents of this directory?\n1. Yes, continue",
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
    const session = await createPaneAdapter({ ...CONFIG, acceptWorkspaceTrust: true }, run).activate(
      activation,
    );
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
    const turn = await session.start(
      { id: "review", prompt: "review", deadline },
      firstBinding,
    );

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
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 3 }, run).activate(activation);
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
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 3 }, run).activate(activation);
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
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 1 }, run).activate(activation);
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "failed" });
    expect(calls.filter((call) => verb(call) === "workspace close")).toHaveLength(1);
  });

  test("compaction explicitly clears inherited operation authority", async () => {
    const { run, calls } = operationStub();
    const session = await createPaneAdapter(CONFIG, run).activate(activation);
    const compact = await session.compact("compact-1", "summarize", activation.deadline);

    await compact.settled;

    const created = calls.find((call) => verb(call) === "workspace create");
    expect(created?.argv).toContain("WF_ENDPOINT=");
    expect(created?.argv).toContain("WF_OPERATION=");
    expect(created?.argv).toContain("WF_CAPABILITY=");
    expect(created?.argv.join(" ")).not.toContain(firstBinding.capability);
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
    const session = await createPaneAdapter({ ...CONFIG, startAttempts: 1 }, run).activate(activation);
    const turn = await session.start(
      { id: "turn-1", prompt: "review", deadline: activation.deadline },
      firstBinding,
    );

    await expect(turn.settled).resolves.toMatchObject({ state: "timed-out" });
  });

  test("cancellation aborts native work and finishes cleanup before returning", async () => {
    const { run: baseRun, calls } = operationStub();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const run: RunProcess = async (input) => {
      if (verb(input) !== "agent prompt") return baseRun(input);
      calls.push(input);
      promptStarted();
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
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

  test("redacts close failures and retains the handle so close can retry", async () => {
    const { run: baseRun, calls } = operationStub();
    let closeAttempts = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) !== "workspace close") return baseRun(input);
      calls.push(input);
      closeAttempts += 1;
      return closeAttempts <= 2
        ? {
            stdout: "",
            stderr: `busy ${firstBinding.operationId} ${firstBinding.capability}`,
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
    const outcome = await turn.settled;
    expect(outcome).toMatchObject({ state: "completed" });
    expect(JSON.stringify(outcome)).not.toContain(firstBinding.capability);

    const firstClose = session.close();
    await expect(firstClose).rejects.toThrow("without safe diagnostic detail");
    await expect(firstClose).rejects.not.toThrow(firstBinding.operationId);
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
  const binding = (operationId: string, capability: string) => ({
    endpoint: "/private/engine.sock",
    operationId,
    capability,
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
      if (command === "pane split") {
        panes += 1;
        return commandResult({ pane: { pane_id: `w1:p${panes}` } });
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
            ...(options.exposeSession === false
              ? {}
              : { session_id: `session-${input.argv[5]}` }),
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

  test("places peer providers in authority-isolated sibling panes of one run tab", async () => {
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
    const first = binding("op-1", "A".repeat(43));
    const second = binding("op-2", "B".repeat(43));
    await Promise.all([
      (await claude.start({ id: "one", prompt: "review", deadline: deadline() }, first)).settled,
      (await codex.start({ id: "two", prompt: "review", deadline: deadline() }, second)).settled,
    ]);

    const creates = calls.filter((call) => verb(call) === "workspace create");
    const splits = calls.filter((call) => verb(call) === "pane split");
    const starts = calls.filter((call) => verb(call) === "agent start");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.argv).toContain("WF_CAPABILITY=");
    expect(creates[0]?.argv).not.toContain(`WF_CAPABILITY=${first.capability}`);
    expect(creates[0]?.argv).not.toContain(`WF_CAPABILITY=${second.capability}`);
    expect(splits).toHaveLength(2);
    expect(splits.every((call) => call.argv.includes("w1:p1"))).toBe(true);
    expect(splits[0]?.argv).toContain(`WF_CAPABILITY=${first.capability}`);
    expect(splits[0]?.argv).not.toContain(`WF_CAPABILITY=${second.capability}`);
    expect(splits[1]?.argv).toContain(`WF_CAPABILITY=${second.capability}`);
    expect(splits[1]?.argv).not.toContain(`WF_CAPABILITY=${first.capability}`);
    expect(starts.map((call) => call.argv[call.argv.indexOf("--kind") + 1]).sort()).toEqual([
      "claude",
      "codex",
    ]);
    const laterArguments = calls
      .filter((call) => !["workspace create", "pane split"].includes(verb(call)))
      .flatMap((call) => call.argv);
    expect(laterArguments).not.toContain(first.capability);
    expect(laterArguments).not.toContain(second.capability);
    expect(JSON.stringify(host.inspect())).not.toContain(first.capability);
    expect(JSON.stringify(host.inspect())).not.toContain(second.capability);

    await host.close();
    expect(calls.filter((call) => verb(call) === "workspace close")).toHaveLength(1);
  });

  test("sibling authority cannot become turn evidence or a native resume reference", async () => {
    const firstCapability = "A".repeat(43);
    const escapedFirst = `\\u${firstCapability.charCodeAt(0).toString(16).padStart(4, "0")}${firstCapability.slice(1)}`;
    const base = hostStub();
    let prompts = 0;
    let reads = 0;
    const run: RunProcess = async (input) => {
      if (verb(input) === "agent prompt") {
        base.calls.push(input);
        prompts += 1;
        return commandResult({
          agent: {
            agent_status: "idle",
            agent_session: {
              kind: "id",
              value: prompts === 1 ? "safe-first-session" : escapedFirst,
            },
          },
        });
      }
      if (verb(input) === "agent read") {
        base.calls.push(input);
        reads += 1;
        return {
          stdout:
            reads === 1
              ? JSON.stringify({ session_id: "safe-first-session", result: "reviewed" })
              : JSON.stringify({ session_id: escapedFirst, result: `leak ${escapedFirst}` }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return base.run(input);
    };
    const host = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const first = await host.openAgent({
      key: "first",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    const second = await host.openAgent({
      key: "second",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "opus" },
    });
    await (
      await first.start(
        { id: "one", prompt: "review", deadline: deadline() },
        binding("op-1", firstCapability),
      )
    ).settled;
    const leaked = await (
      await second.start(
        { id: "two", prompt: "review", deadline: deadline() },
        binding("op-2", "B".repeat(43)),
      )
    ).settled;
    expect(leaked.resultEvidence).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(leaked)).not.toContain(firstCapability);
    expect(JSON.stringify(leaked)).not.toContain(escapedFirst);

    const later = await second.start(
      { id: "three", prompt: "again", deadline: deadline() },
      binding("op-3", "C".repeat(43)),
    );
    await expect(later.settled).resolves.toMatchObject({ state: "failed" });
    const laterCommands = base.calls
      .filter((call) => verb(call) === "agent start")
      .flatMap((call) => call.argv);
    expect(laterCommands).not.toContain(firstCapability);
    expect(laterCommands).not.toContain(escapedFirst);
    await host.close();
  });

  test("nudge stays in its pane and a later operation resumes in a fresh pane", async () => {
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
      binding("op-1", "A".repeat(43)),
    );
    await first.settled;
    await (await first.nudge({ id: "one:nudge", prompt: "report", deadline: deadline() })).settled;
    await (
      await session.start(
        { id: "two", prompt: "review again", deadline: deadline() },
        binding("op-2", "B".repeat(43)),
      )
    ).settled;

    expect(calls.filter((call) => verb(call) === "agent prompt")).toHaveLength(3);
    expect(calls.filter((call) => verb(call) === "pane split")).toHaveLength(2);
    const starts = calls.filter((call) => verb(call) === "agent start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.argv).toContain("resume");
    expect(starts[1]?.argv.some((argument) => argument.startsWith("session-"))).toBe(true);
    await host.close();
  });

  test("a later operation fails closed without native continuation evidence", async () => {
    const { run, calls } = hostStub({ exposeSession: false });
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
      await session.start(
        { id: "one", prompt: "review", deadline: deadline() },
        binding("op-1", "A".repeat(43)),
      )
    ).settled;
    const second = await session.start(
      { id: "two", prompt: "again", deadline: deadline() },
      binding("op-2", "B".repeat(43)),
    );

    await expect(second.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("continuation evidence"),
    });
    const third = await session.start(
      { id: "three", prompt: "again", deadline: deadline() },
      binding("op-3", "C".repeat(43)),
    );
    await expect(third.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("continuation evidence"),
    });
    expect(calls.filter((call) => verb(call) === "pane split")).toHaveLength(1);
    await host.close();
  });

  test("blocked and unknown generations permanently deny later continuation", async () => {
    for (const terminalState of ["blocked", "unknown"] as const) {
      const base = hostStub();
      let prompts = 0;
      const run: RunProcess = async (input) => {
        if (verb(input) !== "agent prompt") return base.run(input);
        base.calls.push(input);
        prompts += 1;
        return commandResult({
          agent: {
            agent_status: prompts === 1 ? "idle" : terminalState,
            agent_session: { kind: "id", value: `session-${prompts}` },
          },
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
      await (
        await session.start(
          { id: "one", prompt: "one", deadline: deadline() },
          binding("op-1", "A".repeat(43)),
        )
      ).settled;
      const second = await session.start(
        { id: "two", prompt: "two", deadline: deadline() },
        binding("op-2", "B".repeat(43)),
      );
      await expect(second.settled).resolves.toMatchObject({
        state: terminalState === "blocked" ? "blocked" : "failed",
      });
      for (const [id, capability] of [
        ["op-3", "C".repeat(43)],
        ["op-4", "D".repeat(43)],
      ] as const) {
        const later = await session.start(
          { id, prompt: "again", deadline: deadline() },
          binding(id, capability),
        );
        await expect(later.settled).resolves.toMatchObject({
          state: "failed",
          detail: expect.stringContaining("continuation evidence"),
        });
      }
      expect(base.calls.filter((call) => verb(call) === "pane split")).toHaveLength(2);
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
      binding("op-1", "A".repeat(43)),
    );
    await promptStarted;

    await expect(turn.release("stop", deadline())).resolves.toMatchObject({
      kind: "released",
      outcome: { state: "cancelled" },
    });
    expect(base.calls.filter((call) => verb(call) === "pane close")).toHaveLength(1);
    for (const [id, capability] of [
      ["op-2", "B".repeat(43)],
      ["op-3", "C".repeat(43)],
    ] as const) {
      const later = await session.start(
        { id, prompt: "again", deadline: deadline() },
        binding(id, capability),
      );
      await expect(later.settled).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining("continuation evidence"),
      });
    }
    expect(base.calls.filter((call) => verb(call) === "pane split")).toHaveLength(1);
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
      binding("op-1", "A".repeat(43)),
    );
    await promptStarted;
    await turn.release("stop", deadline());

    const later = await session.start(
      { id: "two", prompt: "again", deadline: deadline() },
      binding("op-2", "B".repeat(43)),
    );
    await expect(later.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("continuation evidence"),
    });
    expect(base.calls.filter((call) => verb(call) === "pane split")).toHaveLength(1);
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
          root_pane: { pane_id: "w1:p1" },
        });
      }
      if (verb(input) === "workspace close") {
        return { stdout: "", stderr: "workspace busy", exitCode: 1, timedOut: false };
      }
      throw new Error(`unexpected command: ${verb(input)}`);
    };

    await expect(
      createHerdrRunHostFactory(CONFIG, run).openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline: deadline(),
      }),
    ).rejects.toThrow("acquisition and cleanup failed");
    expect(calls.map(verb)).toEqual(["workspace create", "workspace close"]);
  });
});
