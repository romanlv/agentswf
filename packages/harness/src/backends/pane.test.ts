import { describe, expect, test } from "bun:test";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import type { Step } from "../types";
import { createPaneBackend, type PaneConfig } from "./pane";

const CONFIG: PaneConfig = {
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

function argv(calls: ProcessInput[], key: string): string[] {
  const found = calls.find((call) => verb(call) === key);
  return found ? [...found.argv] : [];
}

describe("createPaneBackend", () => {
  test("the call id reaches the agent through the pane environment", async () => {
    const { run, calls } = stub(OPEN);

    await createPaneBackend(CONFIG, run).open(STEP, CALL);

    const created = argv(calls, "workspace create");
    expect(created).toContain("WF_RUN=/runs/r");
    expect(created).toContain("WF_CALL=c1");
    expect(created.join(" ")).toContain("PATH=/wf/bin:");
  });

  test("the harness is launched by its Herdr kind, with its own flags after --", async () => {
    const { run, calls } = stub(OPEN);

    await createPaneBackend(CONFIG, run).open({ ...STEP, harness: "codex", model: "gpt-5" }, CALL);

    const start = argv(calls, "agent start");
    expect(start[start.indexOf("--kind") + 1]).toBe("codex");
    expect(start.slice(start.indexOf("--")).join(" ")).toBe(
      "-- --sandbox danger-full-access --ask-for-approval never --model gpt-5",
    );
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

    await createPaneBackend(CONFIG, run).open(STEP, CALL);

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
      createPaneBackend({ ...CONFIG, startAttempts: 3 }, run).open(STEP, CALL),
    ).rejects.toThrow("agent start failed after 3: agent_pane_busy");
    expect(argv(calls, "workspace close")).toContain("w1");
  });

  test("a prompt is submitted and waited on in one command, timed in milliseconds", async () => {
    const { run, calls } = stub({ ...OPEN, "agent prompt": { agent: { agent_status: "idle" } } });
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

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
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

    expect((await session.prompt("go")).sessionRef).toBe("sess-9");
  });

  test("a status Herdr reports that we do not know is unknown, never done", async () => {
    const { run } = stub({ ...OPEN, "agent prompt": { agent: { agent_status: "compacting" } } });
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

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
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

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
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

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
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

    expect(await session.transcript()).toBeNull();
  });

  test("closing the session closes the workspace it opened", async () => {
    const { run, calls } = stub(OPEN);
    const session = await createPaneBackend(CONFIG, run).open(STEP, CALL);

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

    await expect(createPaneBackend(CONFIG, run).open(STEP, CALL)).rejects.toThrow(
      "workspace create failed: session_not_running",
    );
  });
});
