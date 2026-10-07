import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessInput, ProcessResult, RunProcess } from "@agentswf/harness";
import {
  callerSession,
  installDecisions,
  installOperatorRuntime,
  installSandboxes,
  openRouterKey,
} from "./operator-runtime";

/** Where workspace marks go, never the operator's own `~/.awf`. */
const HOME = mkdtempSync(join(tmpdir(), "awf-runtime-home-"));
afterAll(() => rm(HOME, { recursive: true, force: true }));

describe("operator runtime", () => {
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("awf-agent-bin-")));
  afterAll(() => {
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("awf-agent-bin-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  test("keeps placement out of aliases and installs one run-owned host", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run: subscriptionRunner(calls),
      environment: {},
    });
    try {
      expect(installed.config.aliases.claude).toEqual({
        harness: "claude",
        model: "sonnet",
      });
      expect(installed.config.aliases.codex).toEqual({
        harness: "codex",
        model: "gpt-5.6-sol",
      });
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline,
      });
      expect(host.inspect()).toEqual({ state: "running", agents: [] });
      await host.close();
      expect(host.inspect()).toEqual({ state: "closed", agents: [] });
    } finally {
      await installed.cleanup();
    }
  });

  describe("the session awf run was started from", () => {
    /** A claude home holding each session, on a model unless `false`, last written `ago` ms ago. */
    async function claudeHome(sessions: Record<string, [ago: number, model?: false]>) {
      const home = await mkdtemp(join(HOME, "claude-"));
      const directory = join(home, "projects", "-work");
      await mkdir(directory, { recursive: true });
      for (const [id, [ago, model]] of Object.entries(sessions)) {
        const file = join(directory, `${id}.jsonl`);
        const rows: object[] = [{ type: "user", cwd: "/work", sessionId: id }];
        if (model !== false) {
          rows.push({
            type: "assistant",
            cwd: "/work",
            sessionId: id,
            requestId: `r-${id}`,
            timestamp: new Date().toISOString(),
            message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } },
          });
        }
        await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"));
        const at = new Date(Date.now() - ago);
        await utimes(file, at, at);
      }
      return { CLAUDE_CONFIG_DIR: home };
    }

    const callingOf = async (environment: Record<string, string>, shellCwd?: string) => {
      const installed = await installOperatorRuntime(60_000, {
        home: HOME,
        run: subscriptionRunner([]),
        environment,
        ...(shellCwd === undefined ? {} : { shellCwd }),
      });
      await installed.cleanup();
      const { calling } = installed.config.host;
      return typeof calling === "object" ? { session: calling.session, cwd: calling.cwd } : calling;
    };

    test("is its harness's session variable, in the directory its file records", async () => {
      const home = await claudeHome({ s1: [1_000] });
      expect(await callingOf({ ...home, CLAUDE_CODE_SESSION_ID: "s1" }, "/work/sub")).toEqual({
        session: "s1",
        cwd: "/work",
      });
    });

    test("is none where its file has gone quiet, as an inherited variable's has", async () => {
      const home = await claudeHome({ s1: [60 * 60_000] });
      expect(await callingOf({ ...home, CLAUDE_CODE_SESSION_ID: "s1" }, "/work")).toBe(
        "no session CLAUDE_CODE_SESSION_ID=s1 names was written in the last 10 minutes",
      );
    });

    test("is none where its files name no model to fork it on", async () => {
      const home = await claudeHome({ s2: [1_000, false] });
      expect(await callingOf({ ...home, CLAUDE_CODE_SESSION_ID: "s2" }, "/work")).toBe(
        "claude's files for session s2 name no model it ran on, so a fork of it has none to run on",
      );
    });

    test("is the most recently written, where a variable of another harness is live too", async () => {
      const claude = await claudeHome({ s1: [5 * 60_000] });
      const pi = await mkdtemp(join(HOME, "pi-"));
      const directory = join(pi, "sessions", "--work--");
      await mkdir(directory, { recursive: true });
      const rows = [
        { type: "session", id: "p1", cwd: "/work/pi", timestamp: new Date().toISOString() },
        {
          type: "message",
          id: "m1",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.6-terra",
            usage: { input: 1, output: 1 },
          },
        },
      ];
      await writeFile(
        join(directory, "2026-10-06T12-00-00_p1.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n"),
      );
      const environment = {
        ...claude,
        CLAUDE_CODE_SESSION_ID: "s1",
        PI_CODING_AGENT_DIR: pi,
        PI_SESSION_ID: "p1",
      };
      expect(await callingOf(environment, "/work")).toEqual({ session: "p1", cwd: "/work/pi" });
    });

    test("is none outside an agent's shell, and not looked for without a shell", async () => {
      expect(await callingOf({}, "/work")).toBe("awf run was not started from an agent's shell");
      const home = await claudeHome({ s1: [1_000] });
      expect(await callingOf({ ...home, CLAUDE_CODE_SESSION_ID: "s1" })).toBeUndefined();
    });
  });

  test("each agent runs where its placement says, and an all-headless run never starts Herdr", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run: subscriptionRunner(calls),
      // Inside a Herdr pane, where a pane agent would look its session up.
      environment: { HERDR_SOCKET_PATH: "/h/herdr.sock" },
    });
    try {
      const { host: factory } = installed.config;
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await factory.openRun({ runId: "run-1", cwd: "/repo", deadline });
      const open = (harness: string, extra: object = {}) =>
        host.openAgent({
          key: `${harness}-${JSON.stringify(extra)}`,
          cwd: "/repo",
          deadline,
          execution: { harness, model: "m", placement: "headless", ...extra },
        });
      await expect(open("claude")).rejects.toThrow(
        "headless claude is billed per token even on a subscription login; set metered: true",
      );
      await open("claude", { metered: true });
      const codex = await open("codex");
      await open("pi");
      const turn = await codex.start(
        { id: "turn-1", prompt: "review", deadline },
        { endpoint: "/private/engine.sock", operationId: "op-1" },
      );
      await turn.settled;
      // The refused claude is reported missing, beside the three that opened.
      expect(
        host
          .inspect()
          .agents.map((agent) => agent.state)
          .sort(),
      ).toEqual(["idle", "idle", "idle", "missing"]);
      await host.close();
      expect(host.inspect().state).toBe("closed");
      expect(calls.some((call) => call.argv[0] === "herdr")).toBe(false);
      const agentCall = calls.find((call) => call.argv[0] === "codex" && call.argv[1] === "exec");
      expect(agentCall?.env).toHaveProperty("OPENAI_API_KEY", undefined);
      expect(agentCall?.env).toHaveProperty("CODEX_API_KEY", undefined);

      // Billing follows placement: a headless claude is metered whatever its login.
      const accounting = factory.accounting!;
      const claude = { harness: "claude", model: "sonnet" };
      expect(
        await accounting.billing({ ...claude, placement: "headless", metered: true }, []),
      ).toBe("metered");
      expect(await accounting.billing({ harness: "codex", model: "m" }, [])).toBe("subscription");
      const probed = calls.length;
      const headlessCodex = { harness: "codex", model: "m", placement: "headless" } as const;
      expect(await accounting.billing(headlessCodex, [])).toBe("subscription");
      expect(calls.slice(probed).map((call) => call.argv.join(" "))).toEqual([
        "codex login status",
      ]);
      expect(calls.at(-1)?.env).toHaveProperty("OPENAI_API_KEY", undefined);
    } finally {
      await installed.cleanup();
    }
  });

  test("the caller's session is the one owning its socket, whatever AWF_HERDR_SESSION says", async () => {
    const listed = JSON.stringify({
      sessions: [
        { name: "default", socket_path: "/h/herdr.sock" },
        { name: "review-loop", socket_path: "/h/sessions/review-loop/herdr.sock" },
      ],
    });
    const calls: string[] = [];
    const run: RunProcess = async (input) => {
      calls.push(input.argv.join(" "));
      return success(listed);
    };
    const inPane = { HERDR_SOCKET_PATH: "/h/sessions/review-loop/herdr.sock" };

    expect(await callerSession(run, inPane)).toBe("review-loop");
    expect(calls).toEqual(["herdr session list --json"]);
    expect(await callerSession(run, { ...inPane, AWF_HERDR_SESSION: "wf-lab" })).toBe(
      "review-loop",
    );
    await expect(callerSession(run, {})).rejects.toThrow("not in a Herdr pane");
    const denied: RunProcess = async () => ({
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
      timedOut: false,
    });
    await expect(callerSession(denied, inPane)).rejects.toThrow(
      "herdr session list failed: permission denied",
    );
    await expect(callerSession(run, { HERDR_SOCKET_PATH: "/elsewhere.sock" })).rejects.toThrow(
      "no Herdr session owns /elsewhere.sock",
    );
  });

  test("OPENROUTER_API_KEY installs Jev without refusing the run, and no agent is given it", async () => {
    expect(installDecisions({}).unavailable).toEqual({ jev: "OPENROUTER_API_KEY is not set" });
    expect(installDecisions({ OPENROUTER_API_KEY: "sk-or-one\nsk-or-two" })).toEqual({
      providers: {},
      aliases: {},
      unavailable: { jev: "OPENROUTER_API_KEY is not one token of printable characters" },
    });
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run: subscriptionRunner(calls),
      environment: { OPENROUTER_API_KEY: "sk-or-test" },
    });
    try {
      expect(installed.decisions?.aliases).toEqual({
        jev: { provider: "openrouter", model: "typesafe/jev-1.13" },
      });
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({ runId: "run-1", cwd: "/repo", deadline });
      const codex = await host.openAgent({
        key: "headless",
        cwd: "/repo",
        deadline,
        execution: { harness: "codex", model: "m", placement: "headless" },
      });
      const turn = await codex.start(
        { id: "turn-1", prompt: "review", deadline },
        { endpoint: "/private/engine.sock", operationId: "op-1" },
      );
      await turn.settled;
      // A pane agent gets as far as its workspace, whose environment is where the key is emptied.
      await host
        .openAgent({
          key: "pane",
          cwd: "/repo",
          deadline,
          execution: { harness: "codex", model: "m" },
        })
        .catch(() => undefined);
      await host.close();
      const headless = calls.find((call) => call.argv[0] === "codex" && call.argv[1] === "exec");
      expect(headless?.env).toHaveProperty("OPENROUTER_API_KEY", undefined);
      const workspace = calls.find(
        (call) => call.argv.slice(3, 5).join(" ") === "workspace create",
      );
      expect(workspace?.argv.join(" ")).toContain("OPENROUTER_API_KEY");
      // A herdr started in a pane reads the operator's config, not the run session's quiet one.
      expect(workspace?.argv.join(" ")).toContain("HERDR_CONFIG_PATH");
      expect(calls.some((call) => call.argv.join(" ").includes("sk-or-test"))).toBe(false);
    } finally {
      await installed.cleanup();
    }
  });

  test("no agent inherits the markers of a Claude Code session awf runs inside", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run: subscriptionRunner(calls),
      environment: {},
    });
    try {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({ runId: "run-1", cwd: "/repo", deadline });
      const codex = await host.openAgent({
        key: "headless",
        cwd: "/repo",
        deadline,
        execution: { harness: "codex", model: "m", placement: "headless" },
      });
      const turn = await codex.start(
        { id: "turn-1", prompt: "review", deadline },
        { endpoint: "/private/engine.sock", operationId: "op-1" },
      );
      await turn.settled;
      await host
        .openAgent({
          key: "pane",
          cwd: "/repo",
          deadline,
          execution: { harness: "codex", model: "m" },
        })
        .catch(() => undefined);
      await host.close();
      const headless = calls.find((call) => call.argv[0] === "codex" && call.argv[1] === "exec");
      const workspace = calls.find(
        (call) => call.argv.slice(3, 5).join(" ") === "workspace create",
      );
      // The calling session's markers, and what would override the effort an agent is launched at.
      for (const name of [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_EFFORT",
        "CLAUDE_CODE_EFFORT_LEVEL",
      ]) {
        expect(headless?.env).toHaveProperty(name, undefined);
        expect(workspace?.argv).toContain(`${name}=`);
      }
    } finally {
      await installed.cleanup();
    }
  });

  test("reads OPENROUTER_API_KEY from the environment, else that one name from .env", async () => {
    const directory = await mkdtemp(join(tmpdir(), "awf-dotenv-"));
    try {
      expect(await openRouterKey({}, directory)).toBeUndefined();
      await writeFile(
        join(directory, ".env"),
        'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-other\nexport OPENROUTER_API_KEY="sk-or-file"\n',
      );
      expect(await openRouterKey({}, directory)).toBe("sk-or-file");
      expect(await openRouterKey({ OPENROUTER_API_KEY: "sk-or-shell" }, directory)).toBe(
        "sk-or-shell",
      );
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("sk-ant-other");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses a subscription runtime when metered credentials are configured", async () => {
    let calls = 0;
    const run: RunProcess = async () => {
      calls += 1;
      return success("");
    };
    await expect(
      installOperatorRuntime(60_000, {
        home: HOME,
        run,
        environment: { OPENAI_API_KEY: "metered" },
      }),
    ).rejects.toThrow(
      "subscription runtime refused metered credential environment: OPENAI_API_KEY",
    );
    expect(calls).toBe(0);
  });

  test("checks a harness's subscription login when its first agent opens, and only then", async () => {
    const opened = async (claude: object, codex: string, harness: string) => {
      const calls: string[] = [];
      const run: RunProcess = async (input) => {
        calls.push(input.argv.join(" "));
        return input.argv[0] === "claude"
          ? success(JSON.stringify({ loggedIn: true, ...claude }))
          : success(codex);
      };
      const installed = await installOperatorRuntime(60_000, {
        home: HOME,
        run,
        environment: {},
      });
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({ runId: "run-1", cwd: "/repo", deadline });
      const open = () =>
        host.openAgent({
          key: harness,
          cwd: "/repo",
          deadline,
          execution: { harness, model: "m", placement: "headless", metered: true },
        });
      const first = await open().then(
        () => undefined,
        (error: Error) => error.message,
      );
      const second = await open().then(
        () => undefined,
        (error: Error) => error.message,
      );
      await host.close().catch(() => undefined);
      return { first, second, calls };
    };
    const claudeAi = { authMethod: "claude.ai", apiProvider: "firstParty" };
    const chatgpt = "Logged in using ChatGPT";
    expect((await opened({ authMethod: "api_key" }, chatgpt, "claude")).first).toBe(
      "Claude subscription authentication is required (claude.ai login or `claude setup-token`); `claude auth status` reads as metered",
    );
    // A claude.ai login routed through Bedrock bills the AWS account.
    expect(
      (await opened({ authMethod: "third_party", apiProvider: "bedrock" }, chatgpt, "claude"))
        .first,
    ).toContain("Claude subscription authentication is required");
    const loggedOut = await opened(claudeAi, "Not logged in", "codex");
    expect(loggedOut.first).toBe(
      "Codex subscription authentication is required (ChatGPT login); `codex login status` reads as unknown",
    );
    expect(loggedOut.second).toBe(loggedOut.first);
    expect(
      (await opened(claudeAi, "Logged in using an API key - sk-***", "codex")).first,
    ).toContain("Codex subscription authentication is required");
    const cursorStatus = (isAuthenticated: boolean) => JSON.stringify({ isAuthenticated });
    expect((await opened(claudeAi, cursorStatus(false), "cursor")).first).toBe(
      "Cursor authentication is required (`cursor-agent login`); `cursor-agent status` reads as logged out",
    );
    expect((await opened(claudeAi, cursorStatus(true), "cursor")).first).toBeUndefined();
    // A codex-only run asks codex once and never asks claude: claude's login can be absent.
    const codexOnly = await opened({ authMethod: "api_key" }, chatgpt, "codex");
    expect(codexOnly.first).toBeUndefined();
    expect(codexOnly.calls.filter((c) => c.startsWith("claude"))).toEqual([]);
    expect(codexOnly.calls.filter((c) => c === "codex login status")).toHaveLength(1);
  });

  test("the run session is made ready once for concurrent pane agents, and again after a failure", async () => {
    const calls: ProcessInput[] = [];
    const authenticated = subscriptionRunner([]);
    let down = true;
    const run: RunProcess = async (input) => {
      calls.push(input);
      if (down && input.argv.join(" ") === "herdr session list --json") {
        return success(JSON.stringify({ sessions: [{ name: "awf", running: false }] }));
      }
      return authenticated(input);
    };
    // No PATH, so the down session can't be started and nothing real is.
    const told: unknown[] = [];
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run,
      environment: {},
      onRunSession: (session) => told.push(session),
    });
    const lists = () => calls.filter((call) => call.argv.join(" ") === "herdr session list --json");
    const workspaces = () =>
      calls.filter((call) => call.argv.slice(3, 5).join(" ") === "workspace create");
    try {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const open = (runId: string) =>
        installed.config.host.openRun({ runId, cwd: "/repo", deadline });
      const pane = (host: Awaited<ReturnType<typeof open>>, key: string) =>
        host.openAgent({
          key,
          cwd: "/repo",
          deadline,
          execution: { harness: "codex", model: "m" },
        });
      const failed = await open("run-1");
      await expect(pane(failed, "first")).rejects.toThrow("herdr is not on PATH");
      expect(workspaces()).toEqual([]);
      expect(told).toEqual([]);
      await failed.close().catch(() => undefined);
      // A host opened later asks again: the failure was not kept.
      down = false;
      const host = await open("run-2");
      await Promise.all(["second", "third"].map((key) => pane(host, key).catch(() => undefined)));
      expect(lists()).toHaveLength(2);
      expect(told).toEqual([{ name: "awf", started: false, closed: [], unclaimed: [] }]);
      expect(workspaces().length).toBeGreaterThan(0);
      await host.close().catch(() => undefined);
    } finally {
      await installed.cleanup();
    }
  });

  test("the run session is told once, and a teller that throws fails no agent", async () => {
    const calls: ProcessInput[] = [];
    const told: unknown[] = [];
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run: subscriptionRunner(calls),
      environment: {},
      onRunSession: (session) => {
        told.push(session);
        throw new Error("stderr closed");
      },
    });
    try {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({ runId: "run-1", cwd: "/repo", deadline });
      const pane = (key: string) =>
        host.openAgent({
          key,
          cwd: "/repo",
          deadline,
          execution: { harness: "codex", model: "m" },
        });
      await Promise.all(["first", "second"].map((key) => pane(key).catch(() => undefined)));
      expect(told).toEqual([{ name: "awf", started: false, closed: [], unclaimed: [] }]);
      // Past the session: the pane side opened its workspace.
      expect(calls.some((call) => call.argv.slice(3, 5).join(" ") === "workspace create")).toBe(
        true,
      );
      await host.close().catch(() => undefined);
    } finally {
      await installed.cleanup();
    }
  });

  test("a run's workspace is marked as its own while its host is open", async () => {
    const marks = join(HOME, ".awf", "herdr", "sessions", "awf", "workspaces");
    // A write in flight leaves its temporary file beside the mark, which no reader reads.
    const listed = () =>
      (readdirSync(marks, { withFileTypes: false }) as string[]).filter((file) =>
        file.endsWith(".json"),
      );
    const answer = subscriptionRunner([]);
    let markedBeforeCreate: number | undefined;
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run: async (input) => {
        if (input.argv.slice(3, 5).join(" ") === "workspace create") {
          markedBeforeCreate = listed().length;
        }
        return answer(input);
      },
      environment: {},
    });
    try {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({
        runId: "run-mark",
        label: "awf review run-mark #1",
        cwd: "/repo",
        deadline,
      });
      await host
        .openAgent({
          key: "pane",
          cwd: "/repo",
          deadline,
          execution: { harness: "codex", model: "m" },
        })
        .catch(() => undefined);
      // Written before the workspace, so a sweep never sees one of a live run without it.
      expect(markedBeforeCreate).toBe(1);
      expect(listed()).toHaveLength(1);
      // And given its id once it exists, before any agent opens in it.
      const [file] = listed();
      expect(JSON.parse(readFileSync(join(marks, file!), "utf8")).workspaceId).toBe("w1");
      await host.close().catch(() => undefined);
      expect(listed()).toEqual([]);
    } finally {
      await installed.cleanup();
    }
  });

  test("a run session name Herdr can't use refuses the run before anything starts", async () => {
    const calls: ProcessInput[] = [];
    await expect(
      installOperatorRuntime(60_000, {
        home: HOME,
        run: subscriptionRunner(calls),
        environment: { AWF_HERDR_SESSION: "-oops" },
      }),
    ).rejects.toThrow("not a Herdr session name");
    expect(calls).toEqual([]);
  });

  test.each([
    [{ HERDR_SOCKET_PATH: "/h/herdr.sock" }, "awf"],
    [{ HERDR_SOCKET_PATH: "/h/herdr.sock", AWF_HERDR_SESSION: "wf-lab" }, "wf-lab"],
  ])("pane agents open in the run session, not the caller's: %o", async (environment, session) => {
    const calls: ProcessInput[] = [];
    const authenticated = subscriptionRunner([]);
    const run: RunProcess = async (input) => {
      calls.push(input);
      return authenticated(input);
    };
    const installed = await installOperatorRuntime(60_000, {
      home: HOME,
      run,
      environment,
    });
    try {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({ runId: "run-1", cwd: "/repo", deadline });
      // The pane side opens with the first pane agent; this runner stops it after the workspace.
      await host
        .openAgent({
          key: "pane",
          cwd: "/repo",
          deadline,
          execution: { harness: "codex", model: "m" },
        })
        .catch(() => undefined);
      await host.close().catch(() => undefined);

      const driven = calls.filter((call) => call.argv[1] === "--session");
      expect(driven.length).toBeGreaterThan(0);
      expect(new Set(driven.map((call) => call.argv[2]))).toEqual(new Set([session]));
    } finally {
      await installed.cleanup();
    }
  });
});

function subscriptionRunner(calls: ProcessInput[]): RunProcess {
  let codexTurns = 0;
  return async (input) => {
    calls.push(input);
    if (input.argv.join(" ") === "claude auth status --json") {
      return success(
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
      );
    }
    if (input.argv.join(" ") === "codex login status") {
      return success("Logged in using ChatGPT");
    }
    if (input.argv.join(" ") === "herdr session list --json") {
      return success(
        JSON.stringify({
          sessions: ["default", "awf", "wf-lab"].map((name) => ({
            name,
            running: true,
            socket_path: name === "default" ? "/h/herdr.sock" : `/h/sessions/${name}/herdr.sock`,
          })),
        }),
      );
    }
    if (input.argv.slice(3, 5).join(" ") === "workspace create") {
      return success(
        JSON.stringify({
          result: {
            workspace: { workspace_id: "w1" },
            tab: { tab_id: "w1:t1" },
            root_pane: { pane_id: "w1:p1" },
          },
        }),
      );
    }
    if (input.argv.slice(3, 5).join(" ") === "workspace list") {
      return success(JSON.stringify({ result: { workspaces: [] } }));
    }
    if (input.argv.slice(3).join(" ") === "status server --json") {
      return success(JSON.stringify({ version: "0.9.1", server_binary_stale: false }));
    }
    if (input.argv.slice(3, 5).join(" ") === "workspace close") {
      return success(JSON.stringify({ result: {} }));
    }
    if (input.argv[0] === "codex" && input.argv[1] === "exec") {
      codexTurns += 1;
      return success(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: codexTurns === 1 ? "reviewed" : "reported" },
          }),
        ].join("\n"),
      );
    }
    throw new Error(`unexpected process: ${input.argv.join(" ")}`);
  };
}

function success(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

describe("installSandboxes", () => {
  test("installs srt as the default when its CLI is on PATH, and nothing when nothing answers", async () => {
    expect(await installSandboxes({ PATH: "/nonexistent", HOME: "/" })).toEqual({ installed: {} });
    const here = await installSandboxes(process.env);
    if (Bun.which("srt")) {
      expect(here.default).toBe("srt");
      expect(here.installed.srt).toBeDefined();
    }
  });
});
