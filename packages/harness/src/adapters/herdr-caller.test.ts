import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import { claudeProjectDirectory } from "../usage/claude";
import type { HerdrConfig } from "./herdr";
import { createHerdrCommands } from "./herdr";
import {
  type CallerPane,
  createCallerHostFactory,
  findCallerPane,
  handBack,
  interruptedAfter,
  startInNewTab,
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
        "no agent pane showed awf-here-other in its last 200 lines; the calling session puts it there by replying with it",
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

  async function open(
    caller: CallerPane,
    answer: (input: ProcessInput) => Answer,
    found?: { session: string; cwd: string },
  ) {
    const { run, calls } = herdrWith([], answer);
    const factory = createCallerHostFactory(CONFIG, caller, run, found);
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

  test("a turn whose harness cannot sign in fails, saying so; one before it does not count", async () => {
    const shown = "⎿  Not logged in · Please run /login";
    const { session } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      idle(`${shown}\nPlan op-1.\n${shown}`),
    );
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    expect(await turn.settled).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("claude needs a login"),
      login: { harness: "claude" },
    });
    const { session: earlier } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      idle(`${shown}\nPlan op-1.\nanswered`),
    );
    const next = await earlier.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    expect((await next.settled).state).toBe("completed");
  });

  test("a stalled prompt whose harness cannot sign in fails at once, not at the deadline", async () => {
    const { session } = await open({ paneId: "w1:p1", harness: "pi", cwd: "/repo" }, (input) => {
      if (verb(input) === "agent wait") return ok({ agent: { agent_status: "idle" } });
      if (verb(input) === "agent prompt") {
        return {
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_prompt_stalled" } }),
          exitCode: 1,
          timedOut: false,
        };
      }
      if (verb(input) === "agent read") {
        return ok({}, "Plan op-1.\nError: OAuth refresh failed for openai-codex: 401");
      }
      return undefined;
    });
    const turn = await session.start(
      { id: "t1", prompt: "Plan op-1.", deadline: deadline() },
      binding,
    );
    expect(await turn.settled).toMatchObject({
      state: "failed",
      login: { harness: "pi", provider: "openai-codex" },
    });
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

  test("fresh caller release outlives an expired prompt observation without interrupting", async () => {
    let prompted!: () => void;
    const started = new Promise<void>((resolve) => {
      prompted = resolve;
    });
    let expire!: (result: ProcessResult) => void;
    const original = new Promise<ProcessResult>((resolve) => {
      expire = resolve;
    });
    let finish!: (result: ProcessResult) => void;
    const natural = new Promise<ProcessResult>((resolve) => {
      finish = resolve;
    });
    let waits = 0;
    const { host, session, calls } = await open(
      { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
      (input) => {
        if (verb(input) === "agent wait")
          return ++waits === 1 ? ok({ agent: { agent_status: "idle" } }) : natural;
        if (verb(input) === "agent prompt") {
          prompted();
          return original;
        }
        return undefined;
      },
    );
    const turn = await session.start(
      { id: "turn", prompt: "question", deadline: deadline() },
      binding,
    );
    await started;
    const releasing = turn.release("answer admitted", deadline(), {
      answered: true,
      awaitCompletion: true,
    });
    expire({ stdout: "", stderr: "observation expired", exitCode: 137, timedOut: true });
    await turn.settled;
    expect(await Promise.race([releasing.then(() => "released"), Promise.resolve("pending")])).toBe(
      "pending",
    );
    finish(ok({ agent: { agent_status: "done" } }));
    expect(await releasing).toMatchObject({ kind: "released", outcome: { state: "completed" } });
    await host.close();
    expect(calls.map(verb).some((command) => /send-keys|tab close|agent stop/.test(command))).toBe(
      false,
    );
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

  describe("fork", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    let home: string | undefined;
    afterEach(async () => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      if (home) await rm(home, { recursive: true, force: true });
    });

    /** The operator's claude home, holding `session` logged at these models, in order. */
    async function operatorSession(session: string, rows: { model: string; sidechain?: true }[]) {
      home = await mkdtemp(join(tmpdir(), "awf-caller-fork-"));
      process.env.CLAUDE_CONFIG_DIR = home;
      const directory = await claudeProjectDirectory(home);
      await mkdir(directory, { recursive: true });
      const lines = rows.map(({ model, sidechain }, at) =>
        JSON.stringify({
          type: "assistant",
          uuid: `u${at}`,
          requestId: `r${at}`,
          timestamp: new Date(Date.UTC(2026, 9, 6, 12, at)).toISOString(),
          ...(sidechain ? { isSidechain: true } : {}),
          message: { model, usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      );
      await writeFile(join(directory, `${session}.jsonl`), lines.join("\n"));
      return home;
    }

    const forking = (input: ProcessInput) =>
      input.argv[0] === "claude"
        ? ok({}, JSON.stringify({ session_id: "forked-1", num_turns: 0, total_cost_usd: 0 }))
        : idle("")(input);

    test("forks the operator's session before any turn, once it settles, on its last model", async () => {
      const cwd = await operatorSession("sess-1", [
        { model: "claude-sonnet-5-5" },
        { model: "claude-opus-5-5" },
        { model: "claude-haiku-4-5", sidechain: true },
      ]);
      const { session, calls } = await open(
        { paneId: "w1:p1", harness: "claude", cwd, session: "sess-1" },
        forking,
        { session: "sess-1", cwd },
      );
      expect(session.sessions?.()).toEqual(["sess-1"]);
      expect(await session.fork!(deadline())).toEqual({
        harness: "claude",
        sessionRef: "forked-1",
        costTotal: 0,
        model: "claude-opus-5-5",
      });
      expect(calls.map(verb)[0]).toBe("agent wait");
      const fork = calls.find((input) => input.argv[0] === "claude")!;
      expect(fork.argv).toEqual(expect.arrayContaining(["--resume", "sess-1", "--fork-session"]));
      expect(fork.argv.slice(-2)).toEqual(["--model", "claude-opus-5-5"]);
      expect(fork.cwd).toBe(cwd);
    });

    test("refuses a session whose files name no model it ran on", async () => {
      const cwd = await operatorSession("sess-1", []);
      const { session, calls } = await open(
        { paneId: "w1:p1", harness: "claude", cwd, session: "sess-1" },
        forking,
        { session: "sess-1", cwd },
      );
      await expect(session.fork!(deadline())).rejects.toThrow(
        "the calling session's files name no model it ran on (claude session sess-1)",
      );
      expect(calls.some((input) => input.argv[0] === "claude")).toBe(false);
    });

    test("has no fork without the session's id", async () => {
      const { session } = await open(
        { paneId: "w1:p1", harness: "claude", cwd: "/repo" },
        idle(""),
      );
      expect(session.fork).toBeUndefined();
    });
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

describe("startInNewTab", () => {
  test("closes a tab that came back without a pane", async () => {
    const { run, calls } = herdrWith([], (input) =>
      verb(input) === "tab create" ? ok({ tab: { tab_id: "w1:t2" } }) : undefined,
    );
    const started = await startInNewTab(
      CONFIG,
      { workspace: "w1", cwd: "/repo", label: "awf run", argv: ["awf", "run"] },
      run,
    );
    expect(started).toEqual({ ok: false, error: "tab create returned no tab or pane" });
    expect(calls.map((call) => call.argv.slice(3, 6))).toEqual([
      ["tab", "create", "--workspace"],
      ["tab", "close", "w1:t2"],
    ]);
  });
});
