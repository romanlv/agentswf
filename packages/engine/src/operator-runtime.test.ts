import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessInput, ProcessResult, RunProcess } from "@agentswf/harness";
import {
  herdrSession,
  installDecisions,
  installOperatorRuntime,
  installSandboxes,
  openRouterKey,
} from "./operator-runtime";

describe("operator runtime", () => {
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("awf-agent-bin-")));
  afterAll(() => {
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("awf-agent-bin-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  test("keeps placement out of aliases and installs one run-owned host", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
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

  test("each agent runs where its placement says, and an all-headless run never starts Herdr", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
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

  test("agents open in the Herdr session awf runs in, unless AWF_HERDR_SESSION names one", async () => {
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

    expect(await herdrSession(run, inPane)).toBe("review-loop");
    expect(calls).toEqual(["herdr session list --json"]);
    expect(await herdrSession(run, { ...inPane, AWF_HERDR_SESSION: "wf-lab" })).toBe("wf-lab");
    expect(await herdrSession(run, {})).toBe("default");
    expect(calls).toHaveLength(1);
    await expect(herdrSession(run, { HERDR_SOCKET_PATH: "/elsewhere.sock" })).rejects.toThrow(
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
      expect(calls.some((call) => call.argv.join(" ").includes("sk-or-test"))).toBe(false);
    } finally {
      await installed.cleanup();
    }
  });

  test("no agent inherits the markers of a Claude Code session awf runs inside", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, {
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
      for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN"]) {
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
      installOperatorRuntime(60_000, { run, environment: { OPENAI_API_KEY: "metered" } }),
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
      const installed = await installOperatorRuntime(60_000, { run, environment: {} });
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
    // A codex-only run asks codex once and never asks claude: claude's login can be absent.
    const codexOnly = await opened({ authMethod: "api_key" }, chatgpt, "codex");
    expect(codexOnly.first).toBeUndefined();
    expect(codexOnly.calls.filter((c) => c.startsWith("claude"))).toEqual([]);
    expect(codexOnly.calls.filter((c) => c === "codex login status")).toHaveLength(1);
  });

  test("the herdr session name comes from the injected environment", async () => {
    const calls: ProcessInput[] = [];
    const authenticated = subscriptionRunner([]);
    const run: RunProcess = async (input) => {
      calls.push(input);
      return authenticated(input);
    };
    const installed = await installOperatorRuntime(60_000, {
      run,
      environment: { AWF_HERDR_SESSION: "wf-lab" },
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

      expect(calls.find((call) => call.argv[0] === "herdr")?.argv.slice(0, 3)).toEqual([
        "herdr",
        "--session",
        "wf-lab",
      ]);
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
