import { describe, expect, test } from "bun:test";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import type { HerdrConfig } from "./herdr";
import { createHerdrCommands } from "./herdr";
import {
  type CallerPane,
  createCallerHostFactory,
  findCallerPane,
  handBack,
  interruptedAfter,
} from "./herdr-caller";

const CONFIG: HerdrConfig = {
  session: "default",
  workspaceLabel: "awf run",
  commandTimeoutMs: 1_000,
};

const ok = (result: unknown, stdout?: string) => ({
  stdout: stdout ?? JSON.stringify({ result }),
  stderr: "",
  exitCode: 0,
  timedOut: false,
});

/** The herdr subcommand an input runs, such as `agent prompt`. */
const verb = (input: ProcessInput) => input.argv.slice(3, 5).join(" ");

type Answer = ProcessResult | Promise<ProcessResult> | undefined;

type Pane = { pane_id: string; agent?: string; cwd?: string; screen: string };

function herdrWith(panes: Pane[], answer?: (input: ProcessInput) => Answer) {
  const calls: ProcessInput[] = [];
  const run: RunProcess = async (input) => {
    calls.push(input);
    const answered = answer?.(input);
    if (answered) return answered;
    if (verb(input) === "pane list") {
      return ok({ panes: panes.map(({ screen: _screen, ...pane }) => pane) });
    }
    if (verb(input) === "pane read") {
      const pane = panes.find((candidate) => candidate.pane_id === input.argv[5]);
      return ok({}, pane?.screen ?? "");
    }
    return ok({});
  };
  return { run, calls, herdr: createHerdrCommands(CONFIG, run).herdr };
}

describe("findCallerPane", () => {
  const by = () => Date.now() + 1_000;

  test("finds the one agent pane showing the code, with its harness and directory", async () => {
    const { herdr } = herdrWith([
      { pane_id: "w1:p1", agent: "claude", cwd: "/repo", screen: "⏺ awf-here-abc123" },
      { pane_id: "w1:p2", agent: "codex", cwd: "/other", screen: "nothing here" },
      // A shell, not an agent: the run's own tab types the code in its command line.
      { pane_id: "w1:p3", screen: "awf run --session awf-here-abc123" },
    ]);
    expect(await findCallerPane(herdr, "awf-here-abc123", { by: by() })).toEqual({
      kind: "found",
      pane: { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
    });
  });

  test("refuses when two panes show it", async () => {
    const { herdr } = herdrWith([
      { pane_id: "w1:p1", agent: "claude", cwd: "/repo", screen: "awf-here-abc123" },
      { pane_id: "w1:p2", agent: "pi", cwd: "/repo", screen: "awf-here-abc123" },
    ]);
    const found = await findCallerPane(herdr, "awf-here-abc123", { by: by() });
    expect(found).toEqual({
      kind: "refused",
      reason:
        "more than one pane shows awf-here-abc123 (w1:p1, w1:p2), so the calling session is not known",
    });
  });

  test("refuses a harness awf does not drive", async () => {
    const { herdr } = herdrWith([
      { pane_id: "w1:p1", agent: "gemini", cwd: "/repo", screen: "awf-here-abc123" },
    ]);
    const found = await findCallerPane(herdr, "awf-here-abc123", { by: by() });
    expect(found.kind === "refused" && found.reason).toStartWith(
      "the calling session in w1:p1 is gemini, and awf drives claude",
    );
  });

  test("polls until the code shows, and refuses once its time is up", async () => {
    const panes: Pane[] = [{ pane_id: "w1:p1", agent: "codex", cwd: "/repo", screen: "" }];
    const { herdr } = herdrWith(panes);
    setTimeout(() => {
      panes[0]!.screen = "• awf-here-abc123";
    }, 30);
    const found = await findCallerPane(herdr, "awf-here-abc123", { by: by(), pollMs: 10 });
    expect(found.kind).toBe("found");
    const never = await findCallerPane(herdr, "awf-here-other", {
      by: Date.now() + 50,
      pollMs: 10,
    });
    expect(never).toEqual({
      kind: "refused",
      reason:
        "no agent pane showed awf-here-other; the calling session has to end its turn by replying with it",
    });
  });
});

describe("interruptedAfter", () => {
  const marker = "Conversation interrupted";
  test("counts a marker after this turn's prompt, not one before it", () => {
    expect(interruptedAfter(`old\n${marker}\nrun op-2\nworking`, "op-2", marker)).toBe(false);
    expect(interruptedAfter(`run op-2\nworking\n■ ${marker}`, "op-2", marker)).toBe(true);
  });
  test("a marker the agent's output quotes mid-line is not the harness's", () => {
    expect(interruptedAfter(`run op-2\n  interrupted: "${marker}",`, "op-2", marker)).toBe(false);
    expect(interruptedAfter(`run op-2\n⎿  ${marker} - use /feedback`, "op-2", marker)).toBe(true);
  });
  test("reads everything when the prompt has scrolled out", () => {
    expect(interruptedAfter(`long output\n■ ${marker}`, "op-2", marker)).toBe(true);
  });
});

describe("createCallerHostFactory", () => {
  const binding = { endpoint: "/private/engine.sock", operationId: "op-1" };
  const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });

  async function open(caller: CallerPane, answer: (input: ProcessInput) => Answer) {
    const { run, calls } = herdrWith([], answer);
    const factory = createCallerHostFactory(CONFIG, caller, run);
    const host = await factory.openRun({ runId: "run-1", cwd: "/repo", deadline: deadline() });
    const session = await host.openAgent({
      key: "author",
      deadline: deadline(),
      cwd: caller.cwd,
      execution: { harness: caller.harness, model: "", caller: true },
    });
    return { factory, host, session, calls };
  }

  const idle = (screen: string, session?: string) => (input: ProcessInput) => {
    if (verb(input) === "agent prompt" || verb(input) === "agent wait") {
      return ok({
        agent: {
          agent_status: "done",
          ...(session ? { agent_session: { kind: "id", value: session } } : {}),
        },
      });
    }
    if (verb(input) === "agent read") return ok({}, screen);
    return undefined;
  };

  test("advertises the caller and refuses any other agent", async () => {
    const { factory, host } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      idle(""),
    );
    expect(factory.caller).toEqual({ harness: "claude", cwd: "/repo" });
    await expect(
      host.openAgent({
        key: "other",
        deadline: deadline(),
        cwd: "/repo",
        execution: { harness: "claude", model: "sonnet" },
      }),
    ).rejects.toThrow();
  });

  test("prompts the found pane once it settles, and never opens, closes or names a pane", async () => {
    const { host, session, calls } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      idle("done op-1", "sess-9"),
    );
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    const outcome = await turn.settled;
    expect(outcome.state).toBe("completed");
    await host.close("workflow complete");
    const verbs = calls.map(verb);
    expect(verbs.slice(0, 3)).toEqual(["agent wait", "agent prompt", "agent read"]);
    expect(calls[1]!.argv.slice(5, 7)).toEqual(["w1:p1", "Plan op-1."]);
    expect(verbs.some((each) => /create|close|start|rename|send-keys/.test(each))).toBe(false);
    expect(session.sessions?.()).toEqual(["sess-9"]);
  });

  test("a turn the operator interrupted settles cancelled; one before it does not count", async () => {
    const { session } = await open(
      { paneId: "w1:p1", harness: "codex", cwd: "/repo" },
      idle("■ Conversation interrupted\nPlan op-1.\nworking\n■ Conversation interrupted", "other"),
    );
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    expect(await turn.settled).toMatchObject({
      state: "cancelled",
      detail: "interrupted by the operator",
    });
    // Herdr names another pane's thread under codex's shared daemon; it is not taken.
    expect(session.sessions?.()).toEqual([]);
    const { session: earlier } = await open(
      { paneId: "w1:p1", harness: "codex", cwd: "/repo" },
      idle("■ Conversation interrupted\nPlan op-1.\nanswered"),
    );
    const next = await earlier.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    expect((await next.settled).state).toBe("completed");
  });

  test("cancelling interrupts the run's own turn while it works, and leaves the pane", async () => {
    const { session, calls } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      (input) => {
        if (verb(input) === "agent wait") return ok({ agent: { agent_status: "idle" } });
        if (verb(input) === "agent get") return ok({ agent: { agent_status: "working" } });
        if (verb(input) === "agent prompt") {
          return new Promise((resolve) => {
            input.signal?.addEventListener("abort", () =>
              resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true }),
            );
          });
        }
        return undefined;
      },
    );
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    await Bun.sleep(10);
    const released = await turn.release("operation deadline exceeded", deadline());
    expect(released).toMatchObject({ kind: "released", outcome: { state: "cancelled" } });
    expect(calls.filter((call) => verb(call) === "agent send-keys")).toHaveLength(1);
    expect(calls.map(verb).some((each) => /close/.test(each))).toBe(false);
  });

  test("an answered turn left finishing is never interrupted", async () => {
    const { session, calls } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      (input) => {
        if (verb(input) === "agent wait") return ok({ agent: { agent_status: "idle" } });
        if (verb(input) === "agent get") return ok({ agent: { agent_status: "working" } });
        if (verb(input) === "agent prompt") {
          return new Promise((resolve) => {
            input.signal?.addEventListener("abort", () =>
              resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true }),
            );
          });
        }
        return undefined;
      },
    );
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    await Bun.sleep(10);
    expect(await turn.release("result slot settled", deadline(), { answered: true })).toEqual({
      kind: "finishing",
    });
    await session.close("workflow complete");
    expect(calls.filter((call) => verb(call) === "agent send-keys")).toHaveLength(0);
  });

  test("a prompt Herdr refused leaves nothing to interrupt, and nothing prompted", async () => {
    const { session, calls } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      (input) => {
        if (verb(input) === "agent wait") return ok({ agent: { agent_status: "idle" } });
        if (verb(input) === "agent get") return ok({ agent: { agent_status: "working" } });
        if (verb(input) === "agent prompt") {
          return { stdout: "", stderr: "pane gone", exitCode: 1, timedOut: false };
        }
        return undefined;
      },
    );
    expect(session.promptedAt?.()).toBeUndefined();
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    expect((await turn.settled).state).toBe("failed");
    expect(session.promptedAt?.()).toBeNumber();
    await session.close("workflow complete");
    expect(calls.filter((call) => verb(call) === "agent send-keys")).toHaveLength(0);
  });

  test("compaction is refused before anything is sent", async () => {
    const { session, calls } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      idle(""),
    );
    const turn = await session.compact("c1", "keep the plan", deadline());
    expect(await turn.settled).toMatchObject({
      state: "failed",
      detail: "the calling session's context is the operator's, so a run does not compact it",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("handBack", () => {
  test("waits for the session to settle, then prompts it without waiting for a turn", async () => {
    const { run, calls } = herdrWith([]);
    expect(await handBack(CONFIG, "w1:p1", "[awf] done", run, 100)).toBeUndefined();
    expect(calls.map((call) => call.argv.slice(3))).toEqual([
      ["agent", "wait", "w1:p1", "--timeout", "100"],
      ["agent", "prompt", "w1:p1", "[awf] done"],
    ]);
  });
});
