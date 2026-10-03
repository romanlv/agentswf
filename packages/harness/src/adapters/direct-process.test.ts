import { describe, expect, test } from "bun:test";
import type { Occupant, SandboxedCommand, SandboxProcess } from "@agentswf/sandbox";
import type { HarnessActivation } from "../adapter";
import type { ProcessInput, RunProcess } from "../command";
import { createSingleSessionHostFactory } from "../single-session-host";
import { HARNESSES } from "../spec";
import { createHeadlessAdapter, type DirectProcessConfig } from "./direct-process";
import { createPaneAdapter } from "./herdr";

function stub(stdouts: string[]): {
  run: RunProcess;
  calls: (ProcessInput | SandboxedCommand)[];
} {
  const calls: (ProcessInput | SandboxedCommand)[] = [];
  let turn = 0;
  const run: RunProcess = async (input) => {
    calls.push(input);
    const stdout = stdouts[turn] ?? "";
    turn += 1;
    return { stdout, stderr: "", exitCode: 0, timedOut: false };
  };
  return { run, calls };
}

const claudeOut = (result: string, sessionId = "sess-1") =>
  JSON.stringify({ session_id: sessionId, result });

describe("createHeadlessAdapter", () => {
  const activation: HarnessActivation = {
    key: "reviewer",
    deadline: { unixMilliseconds: Date.now() + 60_000 },
    cwd: "/repo",
    instructions: "Follow repository instructions.",
    execution: {
      harness: "claude",
      model: "opus",
      placement: "headless",
      metered: true,
    },
  };
  const firstBinding = {
    endpoint: "/private/engine.sock",
    operationId: "op-1",
  };
  const turnSpec = { id: "turn-1", prompt: "review", deadline: activation.deadline };
  const nudgeSpec = { id: "turn-1:nudge", prompt: "report", deadline: activation.deadline };

  const headless = (
    run: RunProcess,
    config: Partial<DirectProcessConfig> = {},
    request: typeof activation = activation,
  ) => createHeadlessAdapter(config, run).activate(request);

  test("a nudge resumes the native session in a fresh process environment", async () => {
    const { run, calls } = stub([claudeOut("first"), claudeOut("second")]);
    const session = await headless(run, { newSessionId: () => "chosen" });
    const first = await session.start(turnSpec, firstBinding);
    await expect(first.settled).resolves.toMatchObject({
      state: "completed",
      resultEvidence: { kind: "transcript", text: "first" },
    });
    const nudge = await first.nudge(nudgeSpec);
    await nudge.settled;

    // Nothing about the operation: the agent is told the launcher's path in the prompt, so a
    // turn that carried an environment would be carrying something the next turn must not reuse.
    expect(calls[0]?.env).toEqual({});
    expect(calls[1]?.env).toEqual({});
    expect(calls[0]?.argv).not.toContain("--resume");
    expect(calls[1]?.argv[calls[1].argv.indexOf("--resume") + 1]).toBe("sess-1");
  });

  describe("with skills", () => {
    test("every turn, a resumed one too, carries them where they swallow nothing", async () => {
      const { run, calls } = stub([claudeOut("first"), claudeOut("second")]);
      const session = await headless(
        run,
        {},
        {
          ...activation,
          skills: { directory: "/run/b/.claude/skills", names: ["alpha"], sandboxed: false },
        },
      );
      const first = await session.start(turnSpec, firstBinding);
      await first.settled;
      await (await first.nudge(nudgeSpec)).settled;
      for (const call of calls) {
        const at = call.argv.indexOf("--add-dir");
        expect(call.argv.slice(at - 2, at + 3)).toEqual([
          "--setting-sources",
          "project,local",
          "--add-dir",
          "/run/b",
          "--output-format",
        ]);
      }
      expect(calls[1]?.argv[calls[1].argv.indexOf("--resume") + 1]).toBe("sess-1");
    });

    test("a host codex runs in its own home, with its bundled skills off", async () => {
      const codexOut = JSON.stringify({ type: "thread.started", thread_id: "thread-1" });
      const { run, calls } = stub([codexOut]);
      const session = await headless(
        run,
        {},
        {
          ...activation,
          execution: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
          skills: {
            directory: "/run/b/home/skills",
            names: ["alpha"],
            ownHome: "/run/b/home",
            sandboxed: false,
          },
        },
      );
      await (await session.start(turnSpec, firstBinding)).settled;
      expect(calls[0]?.env).toEqual({ CODEX_HOME: "/run/b/home" });
      const at = calls[0]!.argv.indexOf("skills.bundled.enabled=false");
      expect(calls[0]?.argv[at - 1]).toBe("-c");
      expect(calls[0]?.argv.at(-1)).toBe("-");
    });

    test("in a sandbox, pi's skills come after its extensions flag", async () => {
      const { run, calls } = stub([""]);
      const place: Occupant = {
        launch: (root) => ({ ...root, env: {}, group: true }),
        release: async () => undefined,
      };
      const session = await headless(
        run,
        {},
        {
          ...activation,
          occupant: place,
          execution: { harness: "pi", model: "openai-codex/gpt-6-luna", placement: "headless" },
          skills: { directory: "/box/homes/h/skills", names: ["alpha"], sandboxed: true },
        },
      );
      await (await session.start(turnSpec, firstBinding)).settled;
      const at = calls[0]!.argv.indexOf("--no-extensions");
      expect(calls[0]?.argv.slice(at, at + 4)).toEqual([
        "--no-extensions",
        "--no-skills",
        "--skill",
        "/box/homes/h/skills/alpha",
      ]);
    });

    test("pi's resumed turn names its skills again", async () => {
      const piOut = JSON.stringify({ type: "session", id: "s" });
      const { run, calls } = stub([piOut, piOut]);
      const session = await headless(
        run,
        { newSessionId: () => "s" },
        {
          ...activation,
          execution: { harness: "pi", model: "openai-codex/gpt-6-luna", placement: "headless" },
          skills: { directory: "/run/b/skills", names: ["alpha"], sandboxed: false },
        },
      );
      const first = await session.start(turnSpec, firstBinding);
      await first.settled;
      await (await first.nudge(nudgeSpec)).settled;
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        const at = call.argv.indexOf("--no-skills");
        expect(call.argv.slice(at, at + 3)).toEqual([
          "--no-skills",
          "--skill",
          "/run/b/skills/alpha",
        ]);
      }
    });

    test("an adapter that cannot give skills refuses the agent", async () => {
      const adapter = createPaneAdapter({
        commandTimeoutMs: 1_000,
      } as never);
      await expect(
        adapter.activate({
          ...activation,
          execution: { harness: "claude", model: "opus" },
          skills: { directory: "/run/b/.claude/skills", names: [], sandboxed: false },
        }),
      ).rejects.toThrow("cannot be given skills");
    });
  });

  describe("with an occupant", () => {
    function occupant() {
      const launched: SandboxProcess[] = [];
      let released = 0;
      const place: Occupant = {
        launch(root): SandboxedCommand {
          launched.push(root);
          return { ...root, argv: ["inside", ...root.argv], env: { MARK: "box" }, group: true };
        },
        async release() {
          released += 1;
        },
      };
      return { place, launched, released: () => released };
    }

    test("a first and a resumed turn both run inside, without web tools", async () => {
      const { run, calls } = stub([claudeOut("first"), claudeOut("second")]);
      const { place, launched } = occupant();
      const session = await headless(run, {}, { ...activation, occupant: place });
      const first = await session.start(turnSpec, firstBinding);
      await first.settled;
      await (await first.nudge(nudgeSpec)).settled;

      expect(launched).toHaveLength(2);
      for (const call of calls) {
        expect(call).toMatchObject({ group: true, env: { MARK: "box" } });
        expect(call.argv[0]).toBe("inside");
        expect(call.argv).toContain("WebSearch,WebFetch");
      }
      expect(calls[1]?.argv[calls[1].argv.indexOf("--resume") + 1]).toBe("sess-1");
      expect(launched[0]).toMatchObject({ cwd: "/repo", stdin: expect.stringContaining("review") });
    });

    test("an unsandboxed agent's turn is unchanged", async () => {
      const { run, calls } = stub([claudeOut("first")]);
      const session = await headless(run);
      await (await session.start(turnSpec, firstBinding)).settled;
      expect(calls[0]).not.toHaveProperty("group");
      expect(calls[0]?.argv[0]).toBe("claude");
      expect(calls[0]?.argv).not.toContain("--disallowed-tools");
    });

    test("codex's search flag goes before its stdin marker, on a resumed turn too", async () => {
      const codexOut = (text: string) =>
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
        ].join("\n");
      const { run, calls } = stub([codexOut("first"), codexOut("second")]);
      const session = await headless(
        run,
        {},
        {
          ...activation,
          occupant: occupant().place,
          execution: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
        },
      );
      const first = await session.start(turnSpec, firstBinding);
      await first.settled;
      await (await first.nudge(nudgeSpec)).settled;
      for (const call of calls) {
        const at = call.argv.indexOf('web_search="disabled"');
        expect(call.argv[at - 1]).toBe("-c");
        expect(call.argv.at(-1)).toBe("-");
      }
      expect(calls[1]?.argv.slice(1, 5)).toEqual(["codex", "exec", "resume", "thread-1"]);
    });

    test("cursor cannot run in one, and a pane adapter refuses one", async () => {
      const run: RunProcess = async () => {
        throw new Error("nothing should launch");
      };
      const { place } = occupant();
      await expect(
        headless(
          run,
          {},
          {
            ...activation,
            occupant: place,
            execution: { harness: "cursor", model: "m", placement: "headless" },
          },
        ),
      ).rejects.toThrow("cursor cannot run in a sandbox");
      await expect(
        createPaneAdapter(
          { session: "s", workspaceLabel: "w", commandTimeoutMs: 1_000 },
          run,
        ).activate({
          ...activation,
          occupant: place,
          execution: { harness: "claude", model: "m" },
        }),
      ).rejects.toThrow("pane agents cannot run in a sandbox yet");
    });
  });

  describe("compaction", () => {
    // What each harness printed when it compacted, live (story 015).
    const claudeCompacted = (summary: string) =>
      [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } },
        { type: "user", isSynthetic: true, message: { role: "user", content: summary } },
        { type: "user", isReplay: true, message: { role: "user", content: "Compacted" } },
        {
          type: "result",
          subtype: "success",
          result: "",
          session_id: "sess-1",
          total_cost_usd: 0.02,
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
    const codexCompacted = [
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-1" } } },
      { id: 3, result: {} },
      { id: 4, result: {} },
      { method: "item/completed", params: { item: { type: "contextCompaction" } } },
      { method: "turn/completed", params: { turn: { status: "completed" } } },
    ]
      .map((row) => JSON.stringify({ jsonrpc: "2.0", ...row }))
      .join("\n");
    const piCompacted = JSON.stringify({
      type: "response",
      command: "compact",
      success: true,
      data: { summary: "kept the path" },
    });
    const as = (harness: string, model: string): typeof activation => ({
      ...activation,
      execution: {
        harness,
        model,
        placement: "headless",
        ...(harness === "claude" ? { metered: true } : {}),
      },
    });
    const firstTurn: Record<string, string> = {
      claude: claudeOut("first"),
      codex: JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      pi: JSON.stringify({ type: "session", id: "chosen" }),
    };

    test("claude resumes with /compact and its focus, and answers with the summary it wrote", async () => {
      const { run, calls } = stub([claudeOut("first"), claudeCompacted("the path is 14 m")]);
      const session = await headless(run, { newSessionId: () => "chosen" });
      await (await session.start(turnSpec, firstBinding)).settled;
      const compact = await session.compact("c-1", "Keep the path.", activation.deadline);

      await expect(compact.settled).resolves.toMatchObject({
        state: "completed",
        summary: "the path is 14 m",
        chargesUsd: [0.02],
      });
      expect(calls[1]?.stdin).toBe("/compact Keep the path.");
      expect(calls[1]?.argv).toEqual(expect.arrayContaining(["--resume", "sess-1", "stream-json"]));
      // The workflow's instructions went with the first turn and are not repeated.
      expect(calls[1]?.stdin).not.toContain(activation.instructions);
    });

    test("claude that wrote no compaction fails it", async () => {
      const { run } = stub([claudeOut("first"), claudeOut("Unknown command")]);
      const session = await headless(run);
      await (await session.start(turnSpec, firstBinding)).settled;
      const compact = await session.compact("c-1", "Keep the path.", activation.deadline);

      await expect(compact.settled).resolves.toMatchObject({
        state: "failed",
        detail: "claude wrote no compaction: Unknown command",
      });
    });

    test("codex compacts on its app-server, the focus injected first, with stdin held open", async () => {
      const { run, calls } = stub([firstTurn.codex!, codexCompacted]);
      const session = await headless(run, {}, as("codex", "gpt-6-luna"));
      await (await session.start(turnSpec, firstBinding)).settled;
      const compact = await session.compact("c-1", "Keep the path.", activation.deadline);

      await expect(compact.settled).resolves.toMatchObject({ state: "completed", summary: "" });
      const call = calls[1] as ProcessInput;
      expect(call.argv.slice(0, 4)).toEqual(["codex", "app-server", "--listen", "stdio://"]);
      const requests = call
        .stdin!.trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
        "thread/inject_items",
        "thread/compact/start",
      ]);
      expect(requests[2].params).toMatchObject({ threadId: "thread-1", model: "gpt-6-luna" });
      expect(JSON.stringify(requests[3].params)).toContain("Keep the path.");
      expect(call.holdStdinUntil?.(JSON.stringify({ method: "turn/completed" }))).toBe(true);
      expect(call.holdStdinUntil?.(JSON.stringify({ id: 4, error: { message: "no" } }))).toBe(true);
      expect(call.holdStdinUntil?.(JSON.stringify({ method: "item/started" }))).toBe(false);
    });

    test("codex refusing the thread fails the compaction with its reason", async () => {
      const refused = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: { message: "no such thread" },
      });
      const { run } = stub([firstTurn.codex!, refused]);
      const session = await headless(run, {}, as("codex", "gpt-6-luna"));
      await (await session.start(turnSpec, firstBinding)).settled;
      const compact = await session.compact("c-1", "Keep the path.", activation.deadline);

      await expect(compact.settled).resolves.toMatchObject({
        state: "failed",
        detail: "codex refused: no such thread",
      });
    });

    test("pi compacts in rpc mode with the focus as its instructions, and answers its summary", async () => {
      const { run, calls } = stub([firstTurn.pi!, piCompacted]);
      const session = await headless(run, { newSessionId: () => "chosen" }, as("pi", "terra"));
      await (await session.start(turnSpec, firstBinding)).settled;
      const compact = await session.compact("c-1", "Keep the path.", activation.deadline);

      await expect(compact.settled).resolves.toMatchObject({
        state: "completed",
        summary: "kept the path",
      });
      const call = calls[1] as ProcessInput;
      expect(call.argv).toEqual(
        expect.arrayContaining(["--mode", "rpc", "--session-id", "chosen"]),
      );
      expect(JSON.parse(call.stdin!)).toEqual({
        type: "compact",
        customInstructions: "Keep the path.",
      });
    });

    test("pi with nothing to compact fails it, saying so", async () => {
      const tooSmall = JSON.stringify({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      const { run } = stub([firstTurn.pi!, tooSmall]);
      const session = await headless(run, {}, as("pi", "terra"));
      await (await session.start(turnSpec, firstBinding)).settled;
      const compact = await session.compact("c-1", "Keep the path.", activation.deadline);

      await expect(compact.settled).resolves.toMatchObject({
        state: "failed",
        detail: "pi did not compact: Nothing to compact (session too small)",
      });
    });

    test("cursor, which has no compaction, and a compaction before any turn run nothing", async () => {
      const { run, calls } = stub([JSON.stringify({ session_id: "c1", result: "ok" })]);
      const cursor = await headless(run, {}, as("cursor", "composer"));
      await (await cursor.start(turnSpec, firstBinding)).settled;
      await expect(
        (await cursor.compact("c-1", "Keep it.", activation.deadline)).settled,
      ).resolves.toMatchObject({ state: "failed", detail: "cursor has no compaction of its own" });

      const fresh = await headless(run);
      await expect(
        (await fresh.compact("c-1", "Keep it.", activation.deadline)).settled,
      ).resolves.toMatchObject({
        state: "failed",
        detail: "there is nothing to compact before the first turn",
      });
      expect(calls).toHaveLength(1);
    });
  });

  test("the prompt rides on stdin, where no CLI reinterprets it", async () => {
    const { run, calls } = stub([claudeOut("done")]);
    const prompt = "count the e's in 'agent terminal'";
    const session = await headless(run);
    await (await session.start({ ...turnSpec, prompt }, firstBinding)).settled;

    expect(calls[0]?.stdin).toBe(`${activation.instructions}\n\n${prompt}`);
    expect(calls[0]?.argv).not.toContain(prompt);
  });

  test("the session id pi is given up front is the one its nudge resumes", async () => {
    const { run, calls } = stub(["{}", "{}"]);
    const session = await headless(
      run,
      { newSessionId: () => "chosen-id" },
      { ...activation, execution: { harness: "pi", model: "opus", placement: "headless" } },
    );
    const turn = await session.start(turnSpec, firstBinding);
    await turn.settled;
    await (await turn.nudge(nudgeSpec)).settled;

    expect(calls[0]?.argv[calls[0].argv.indexOf("--session-id") + 1]).toBe("chosen-id");
    expect(calls[1]?.argv[calls[1].argv.indexOf("--session-id") + 1]).toBe("chosen-id");
  });

  test("what the turn cost is carried out of the harness envelope", async () => {
    const { run } = stub([
      JSON.stringify({
        session_id: "s",
        result: "done",
        total_cost_usd: 0.042,
        usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 900 },
      }),
    ]);
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    expect((await turn.settled).chargesUsd).toEqual([0.042]);
  });

  describe("fork", () => {
    // What `claude -p --resume … --fork-session … ` printed for `/cost` (F7, F9).
    const forked = (sessionId: string, total = 0.123, turns = 0) =>
      JSON.stringify({
        session_id: sessionId,
        result: "",
        num_turns: turns,
        total_cost_usd: total,
      });

    test("claude forks with /cost into the id it is given, asking the model nothing", async () => {
      const { run, calls } = stub([claudeOut("first"), forked("fork-1")]);
      const session = await headless(run, { newSessionId: () => "fork-1" });
      await (await session.start(turnSpec, firstBinding)).settled;
      const fork = await session.fork!(activation.deadline);

      expect(fork).toEqual({ harness: "claude", sessionRef: "fork-1", costTotal: 0.123 });
      expect(calls[1]?.stdin).toBe("/cost");
      expect(calls[1]?.argv).toEqual(
        expect.arrayContaining(["--resume", "sess-1", "--fork-session", "--session-id", "fork-1"]),
      );
      expect(calls[1]?.argv).toEqual(expect.arrayContaining(["--model", "opus"]));
    });

    test("a fork that asked the model, or wrote no new session, fails", async () => {
      for (const [stdout, error] of [
        [forked("fork-1", 0.2, 1), "claude asked the model while forking"],
        [forked("sess-1"), "claude wrote no fork"],
      ] as const) {
        const { run } = stub([claudeOut("first"), stdout]);
        const session = await headless(run, { newSessionId: () => "fork-1" });
        await (await session.start(turnSpec, firstBinding)).settled;
        await expect(session.fork!(activation.deadline)).rejects.toThrow(error);
      }
    });

    test("a continued fork resumes its copy with its own instructions, and charges from its parent's total", async () => {
      const { run, calls } = stub([
        JSON.stringify({ session_id: "fork-1", result: "ok", total_cost_usd: 0.13 }),
      ]);
      const session = await headless(
        run,
        {},
        {
          ...activation,
          instructions: "You write the tests.",
          continues: { harness: "claude", sessionRef: "fork-1", costTotal: 0.123 },
        },
      );
      const turn = await session.start(turnSpec, firstBinding);

      expect((await turn.settled).chargesUsd).toEqual([0.007]);
      expect(calls[0]?.argv[calls[0].argv.indexOf("--resume") + 1]).toBe("fork-1");
      expect(calls[0]?.stdin).toBe(`You write the tests.\n\n${turnSpec.prompt}`);
      expect(session.sessions?.()).toEqual(["fork-1"]);
    });

    test("a fork that printed no total charges its first turn nothing, never its parent's spend", async () => {
      const { run } = stub([
        JSON.stringify({ session_id: "fork-1", result: "ok", total_cost_usd: 0.13 }),
        JSON.stringify({ session_id: "fork-1", result: "ok", total_cost_usd: 0.15 }),
      ]);
      const session = await headless(
        run,
        {},
        { ...activation, continues: { harness: "claude", sessionRef: "fork-1" } },
      );
      const first = await session.start(turnSpec, firstBinding);
      expect((await first.settled).chargesUsd).toEqual([]);
      const second = await session.start(
        { ...turnSpec, id: "turn-2" },
        { ...firstBinding, operationId: "op-2" },
      );
      expect((await second.settled).chargesUsd).toEqual([0.02]);
    });

    test("a fork compacted before its first turn still gives that turn its instructions", async () => {
      const compacted = [
        { type: "system", subtype: "compact_boundary" },
        { type: "user", isSynthetic: true, message: { role: "user", content: "kept" } },
        { type: "result", result: "", session_id: "fork-1" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
      const { run, calls } = stub([compacted, claudeOut("ok", "fork-1")]);
      const session = await headless(
        run,
        {},
        {
          ...activation,
          instructions: "You write the tests.",
          continues: { harness: "claude", sessionRef: "fork-1" },
        },
      );
      await (await session.compact("c-1", "Keep it.", activation.deadline)).settled;
      await (await session.start(turnSpec, firstBinding)).settled;
      expect(calls[0]?.stdin).toBe("/compact Keep it.");
      expect(calls[1]?.stdin).toBe(`You write the tests.\n\n${turnSpec.prompt}`);
    });

    test("a sandboxed agent forks inside, as its turns run", async () => {
      const occupant: Occupant = {
        launch: (root): SandboxedCommand => ({
          ...root,
          argv: ["inside", ...root.argv],
          group: true,
        }),
        async release() {},
      };
      const { run, calls } = stub([claudeOut("first"), forked("fork-1")]);
      const session = await headless(
        run,
        { newSessionId: () => "fork-1" },
        { ...activation, occupant },
      );
      await (await session.start(turnSpec, firstBinding)).settled;
      await session.fork!(activation.deadline);

      expect(calls[1]?.argv[0]).toBe("inside");
    });

    test("an agent is not forked before its first turn, and a harness with none has no fork", async () => {
      const { run, calls } = stub([]);
      const session = await headless(run);
      await expect(session.fork!(activation.deadline)).rejects.toThrow(
        "an agent cannot be forked before its first turn",
      );
      const cursor = await headless(
        run,
        {},
        {
          ...activation,
          execution: { harness: "cursor", model: "composer", placement: "headless" },
        },
      );
      expect(cursor.fork).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    test("a fork of another harness's session is refused", async () => {
      const { run } = stub([]);
      await expect(
        headless(run, {}, { ...activation, continues: { harness: "codex", sessionRef: "t-1" } }),
      ).rejects.toThrow("agent reviewer runs claude, not the codex it would continue");
    });
  });

  describe("claude prints its session's running total, and each turn charges what it added (F9)", () => {
    const priced = (total: number | undefined, result = "ok") =>
      JSON.stringify({
        session_id: "sess-1",
        result,
        ...(total === undefined ? {} : { total_cost_usd: total }),
      });
    const charges = async (turn: { settled: Promise<{ chargesUsd: readonly number[] }> }) =>
      (await turn.settled).chargesUsd;

    test("two turns, a nudge and a compaction each charge the difference", async () => {
      const compacted = [
        { type: "system", subtype: "compact_boundary" },
        { type: "user", isSynthetic: true, message: { role: "user", content: "kept" } },
        { type: "result", result: "", session_id: "sess-1", total_cost_usd: 0.1017 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
      const { run } = stub([priced(0.0753), priced(0.0871), priced(0.09), compacted]);
      const session = await headless(run);
      const first = await session.start(turnSpec, firstBinding);
      expect(await charges(first)).toEqual([0.0753]);
      const second = await session.start(
        { ...turnSpec, id: "turn-2" },
        { ...firstBinding, operationId: "op-2" },
      );
      expect(await charges(second)).toEqual([0.0118]);
      expect(await charges(await second.nudge(nudgeSpec))).toEqual([0.0029]);
      const compact = await session.compact("c-1", "Keep it.", activation.deadline);
      expect(await charges(compact)).toEqual([0.0117]);
    });

    test("a turn that printed no total leaves its cost to the next one that does", async () => {
      const { run } = stub([priced(0.05), priced(undefined), priced(0.08)]);
      const session = await headless(run);
      await (await session.start(turnSpec, firstBinding)).settled;
      const silent = await session.start(
        { ...turnSpec, id: "turn-2" },
        { ...firstBinding, operationId: "op-2" },
      );
      expect(await charges(silent)).toEqual([]);
      const third = await session.start(
        { ...turnSpec, id: "turn-3" },
        { ...firstBinding, operationId: "op-3" },
      );
      expect(await charges(third)).toEqual([0.03]);
    });

    test("a resume that started a session of its own charges all it printed", async () => {
      const { run } = stub([
        priced(0.05),
        JSON.stringify({ session_id: "sess-2", result: "ok", total_cost_usd: 0.06 }),
      ]);
      const session = await headless(run);
      await (await session.start(turnSpec, firstBinding)).settled;
      const second = await session.start(
        { ...turnSpec, id: "turn-2" },
        { ...firstBinding, operationId: "op-2" },
      );
      expect(await charges(second)).toEqual([0.06]);
    });

    test("a total that drops charges the new total, never a negative", async () => {
      const { run } = stub([priced(0.05), priced(0.01)]);
      const session = await headless(run);
      await (await session.start(turnSpec, firstBinding)).settled;
      const second = await session.start(
        { ...turnSpec, id: "turn-2" },
        { ...firstBinding, operationId: "op-2" },
      );
      expect(await charges(second)).toEqual([0.01]);
    });
  });

  test("a pi turn charges every request it made, not only the last", async () => {
    const turnEnd = (total: number) =>
      JSON.stringify({ type: "turn_end", message: { usage: { cost: { total } } } });
    const { run } = stub([
      [JSON.stringify({ type: "session", id: "chosen" }), turnEnd(0.01), turnEnd(0.02)].join("\n"),
    ]);
    const session = await headless(
      run,
      {},
      { ...activation, execution: { harness: "pi", model: "terra", placement: "headless" } },
    );
    const turn = await session.start(turnSpec, firstBinding);
    expect((await turn.settled).chargesUsd[0]).toBeCloseTo(0.03, 12);
  });

  test("a turn that reports no session is not resumed under an id the harness never saw", async () => {
    const { run, calls } = stub(["no session id anywhere in this output"]);
    const session = await headless(run, { newSessionId: () => "invented" });
    const turn = await session.start(turnSpec, firstBinding);
    await turn.settled;
    const nudge = await turn.nudge(nudgeSpec);

    await expect(nudge.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("no resumable native session reference"),
    });
    expect(calls).toHaveLength(1);
  });

  test("a charge the turn never printed stays absent rather than becoming zero", async () => {
    const { run } = stub(["a screen with no JSON on it"]);
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    expect((await turn.settled).chargesUsd).toEqual([]);
  });

  test("a harness with no confirmed resume cannot be nudged, and says so", async () => {
    const { run, calls } = stub([JSON.stringify({ type: "thread.started", thread_id: "t-1" })]);
    const { resumeTurn } = HARNESSES.codex;
    delete HARNESSES.codex.resumeTurn;
    try {
      const session = await headless(
        run,
        {},
        {
          ...activation,
          execution: { harness: "codex", model: "gpt-5.6-sol", placement: "headless" },
        },
      );
      const turn = await session.start(turnSpec, firstBinding);
      await turn.settled;
      const nudge = await turn.nudge(nudgeSpec);

      await expect(nudge.settled).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining("no confirmed headless resume"),
      });
      expect(calls).toHaveLength(1);
    } finally {
      HARNESSES.codex.resumeTurn = resumeTurn;
    }
  });

  test("a nonzero exit fails the turn instead of passing off an empty answer", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "credit balance too low",
      exitCode: 1,
      timedOut: false,
    });
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await expect(turn.settled).resolves.toMatchObject({
      state: "failed",
      detail: expect.stringContaining("credit balance too low"),
    });
  });

  test("runs only headless agents, and claude only when it is marked metered", async () => {
    const run: RunProcess = async () => {
      throw new Error("nothing should launch");
    };
    const { placement: _placement, ...pane } = activation.execution;
    await expect(headless(run, {}, { ...activation, execution: pane })).rejects.toThrow(
      "adapter runs headless agents, not pane",
    );
    const { metered: _metered, ...unmetered } = activation.execution;
    await expect(headless(run, {}, { ...activation, execution: unmetered })).rejects.toThrow(
      "headless claude is billed per token even on a subscription login; set metered: true",
    );
  });

  test("reports lifecycle status and closes idempotently", async () => {
    let release!: () => void;
    const run: RunProcess = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stdout: claudeOut("done"), stderr: "", exitCode: 0, timedOut: false };
    };
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);
    expect(await session.status()).toEqual({ state: "working" });
    release();
    await turn.settled;
    expect(await session.status()).toEqual({ state: "idle" });
    await session.close();
    await session.close();
    expect(await session.status()).toEqual({ state: "missing" });
  });

  test("cancellation reaches the active child process", async () => {
    const run: RunProcess = async (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () =>
            resolve({
              stdout: "",
              stderr: "",
              exitCode: 137,
              timedOut: false,
              cancelled: true,
            }),
          { once: true },
        );
      });
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await expect(turn.release("stop", activation.deadline)).resolves.toMatchObject({
      kind: "released",
    });
    await expect(turn.settled).resolves.toMatchObject({ state: "cancelled" });
  });

  /** Codex that is still writing its closing message when its answer is taken. */
  function finishingCodex() {
    const calls: ProcessInput[] = [];
    const finishers: Array<() => void> = [];
    const thread = JSON.stringify({ type: "thread.started", thread_id: "thread-1" });
    const run: RunProcess = async (input) => {
      calls.push(input);
      return new Promise((resolve) => {
        finishers.push(() => resolve({ stdout: thread, stderr: "", exitCode: 0, timedOut: false }));
        input.signal?.addEventListener("abort", () =>
          resolve({ stdout: thread, stderr: "", exitCode: 137, timedOut: false, cancelled: true }),
        );
      });
    };
    const codex = {
      ...activation,
      execution: { harness: "codex", model: "gpt-5.6-terra", placement: "headless" as const },
    };
    return { calls, finishers, run, codex };
  }

  test("an answered turn is left to finish, and the next operation waits for it and resumes", async () => {
    const { calls, finishers, run, codex } = finishingCodex();
    // The production path: the engine reaches the adapter through the single-session host.
    const host = await createSingleSessionHostFactory(createHeadlessAdapter({}, run)).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: activation.deadline,
    });
    const session = await host.openAgent(codex);
    const first = await session.start(turnSpec, firstBinding);

    const released = await first.release("result slot settled", activation.deadline, {
      answered: true,
    });
    expect(released.kind).toBe("finishing");
    expect(calls[0]?.signal?.aborted).toBe(false);

    let secondStarted = false;
    const second = session
      .start(
        { ...turnSpec, id: "turn-2", prompt: "and now?" },
        { ...firstBinding, operationId: "op-2" },
      )
      .then((turn) => {
        secondStarted = true;
        return turn;
      });
    await Bun.sleep(20);
    expect(secondStarted).toBe(false);
    finishers[0]!();
    await expect(first.settled).resolves.toMatchObject({ state: "completed" });
    await second;
    expect(calls[1]?.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "thread-1"]);
    expect(calls[1]?.stdin).toBe("and now?");
    await host.close();
    expect(calls[1]?.signal?.aborted).toBe(true);
  });

  test("a follow-up waits at most half its time for the answered turn, then stops it and resumes", async () => {
    const { calls, run, codex } = finishingCodex();
    const session = await headless(run, {}, codex);
    const first = await session.start(turnSpec, firstBinding);
    await first.release("result slot settled", activation.deadline, { answered: true });

    const began = Date.now();
    await session.start(
      { ...turnSpec, id: "turn-2", deadline: { unixMilliseconds: began + 200 } },
      { ...firstBinding, operationId: "op-2" },
    );
    const waited = Date.now() - began;
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(190);
    expect(calls[0]?.signal?.aborted).toBe(true);
    await expect(first.settled).resolves.toMatchObject({ state: "cancelled" });
    expect(calls[1]?.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "thread-1"]);
    await session.close();
  });

  test("an answered turn with no follow-up is stopped after its grace and leaves the agent idle", async () => {
    const { calls, run, codex } = finishingCodex();
    const session = await headless(run, { finishGraceMs: 30 }, codex);
    const first = await session.start(
      { ...turnSpec, deadline: { unixMilliseconds: Date.now() + 10 } },
      firstBinding,
    );
    await first.release("result slot settled", activation.deadline, { answered: true });
    await expect(session.status()).resolves.toEqual({ state: "working" });

    // Past its own operation's deadline too: its answer was taken in time, so this is no timeout.
    await expect(first.settled).resolves.toMatchObject({ state: "cancelled" });
    expect(calls[0]?.signal?.aborted).toBe(true);
    await expect(session.status()).resolves.toEqual({ state: "idle" });
    await session.close();
  });

  test("the host shows a follow-up working while it waits, and a closed agent missing", async () => {
    const { finishers, run, codex } = finishingCodex();
    const host = await createSingleSessionHostFactory(createHeadlessAdapter({}, run)).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: activation.deadline,
    });
    const session = await host.openAgent(codex);
    const first = await session.start(turnSpec, firstBinding);
    await first.release("result slot settled", activation.deadline, { answered: true });
    const state = () => host.inspect().agents[0]?.state;

    const second = session.start(
      { ...turnSpec, id: "turn-2" },
      { ...firstBinding, operationId: "op-2" },
    );
    await Bun.sleep(20);
    expect(state()).toBe("working");
    await expect(session.status()).resolves.toEqual({ state: "working" });
    finishers[0]!();
    await first.settled;
    await second;
    expect(state()).toBe("working");

    const secondTurn = await second;
    await secondTurn.release("result slot settled", activation.deadline, { answered: true });
    await host.close();
    await secondTurn.settled;
    await Bun.sleep(0);
    expect(state()).toBe("missing");
  });

  test("a release that is not answered stops the turn at once", async () => {
    const { calls, run, codex } = finishingCodex();
    const session = await headless(run, {}, codex);
    const turn = await session.start(turnSpec, firstBinding);
    await expect(
      turn.release("operation deadline exceeded", activation.deadline),
    ).resolves.toMatchObject({ kind: "released", outcome: { state: "cancelled" } });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  test("a session id pi was handed is not resumed when that turn failed to run", async () => {
    const calls: ProcessInput[] = [];
    const run: RunProcess = async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { stdout: "", stderr: "pi: not found", exitCode: 127, timedOut: false }
        : { stdout: "{}", stderr: "", exitCode: 0, timedOut: false };
    };
    const session = await headless(
      run,
      { newSessionId: () => "hinted" },
      { ...activation, execution: { harness: "pi", model: "m", placement: "headless" } },
    );
    await (await session.start(turnSpec, firstBinding)).settled;
    const second = await session.start(
      { ...turnSpec, id: "turn-2" },
      { ...firstBinding, operationId: "op-2" },
    );
    await expect(second.settled).resolves.toMatchObject({
      state: "failed",
      detail: "pi produced no resumable native session reference",
    });
    expect(calls).toHaveLength(1);
  });

  test("a process stopped at the deadline is timed out, not an empty answer", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 137,
      timedOut: true,
    });
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await expect(turn.settled).resolves.toMatchObject({
      state: "timed-out",
      detail: "timed out at operation deadline",
    });
  });

  test("close aborts and waits for the active child", async () => {
    let aborted = false;
    const run: RunProcess = async (input) =>
      new Promise((resolve) =>
        input.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({
              stdout: "",
              stderr: "",
              exitCode: 137,
              timedOut: false,
              cancelled: true,
            });
          },
          { once: true },
        ),
      );
    const session = await headless(run);
    const turn = await session.start(turnSpec, firstBinding);

    await session.close();

    expect(aborted).toBe(true);
    await expect(turn.settled).resolves.toMatchObject({ state: "cancelled" });
    await expect(session.status()).resolves.toEqual({ state: "missing" });
  });
});
