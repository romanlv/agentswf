import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ProcessInput, ProcessResult, RunProcess } from "@wf/harness";
import { installOperatorRuntime, withoutMeteredCredentials } from "./operator-runtime";

describe("operator runtime", () => {
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("awf-agent-bin-")));
  afterAll(() => {
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("awf-agent-bin-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  test("keeps placement out of aliases and installs one run-owned host", async () => {
    const calls: ProcessInput[] = [];
    const installed = await installOperatorRuntime(60_000, subscriptionRunner(calls), {});
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

  test("refuses a subscription runtime when metered credentials are configured", async () => {
    let calls = 0;
    const run: RunProcess = async () => {
      calls += 1;
      return success("");
    };
    await expect(
      installOperatorRuntime(60_000, run, { OPENAI_API_KEY: "metered" }),
    ).rejects.toThrow("subscription runtime refused metered credential environment: OPENAI_API_KEY");
    expect(calls).toBe(0);
  });

  test("requires persisted subscription authentication", async () => {
    const run: RunProcess = async (input) =>
      input.argv[0] === "claude"
        ? success(JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" }))
        : success("Logged in using ChatGPT");
    await expect(installOperatorRuntime(60_000, run, {})).rejects.toThrow(
      "Claude subscription authentication is required",
    );
  });

  test("removes metered credentials and leaves everything else alone", () => {
    const input = withoutMeteredCredentials({
      argv: ["codex", "exec"],
      timeoutMs: 1_000,
      env: {
        OPENAI_API_KEY: "metered",
        OPENAI_BASE_URL: "https://metered.example",
        CODEX_API_KEY: "metered",
        ANTHROPIC_API_KEY: "metered",
        TERM: "xterm-256color",
      },
    });
    expect(input.env).toMatchObject({
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      CODEX_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: undefined,
      TERM: "xterm-256color",
    });
  });
  test("the herdr session name comes from the injected environment", async () => {
    const calls: ProcessInput[] = [];
    const authenticated = subscriptionRunner([]);
    const run: RunProcess = async (input) => {
      calls.push(input);
      return authenticated(input);
    };
    const installed = await installOperatorRuntime(60_000, run, { AWF_HERDR_SESSION: "wf-lab" });
    try {
      const deadline = { unixMilliseconds: Date.now() + 60_000 };
      const host = await installed.config.host.openRun({ runId: "run-1", cwd: "/repo", deadline });
      await host.close();

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
    if (input.argv.join(" ") === "claude auth status") {
      return success(
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
      );
    }
    if (input.argv.join(" ") === "codex login status") {
      return success("Logged in using ChatGPT");
    }
    if (input.argv.slice(3, 5).join(" ") === "workspace create") {
      return success(JSON.stringify({
        result: {
          workspace: { workspace_id: "w1" },
          tab: { tab_id: "w1:t1" },
          root_pane: { pane_id: "w1:p1" },
        },
      }));
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
