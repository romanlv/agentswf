/**
 * The pooled-pane shape: one pane, many calls, reset in between.
 *
 * Herdr has no reset verb, so the reset is the harness's own slash command sent down the same
 * `agent prompt` path a task uses. `RESET` records what each harness offers; a harness with
 * nothing usable belongs in that table as `null`, not as an invented sequence.
 */
import { runProcess, type RunProcess } from "../deps";
import { harnessSpec } from "../deps";
import type { Harness, SettledState } from "../deps";

export type ResetPlan = {
  /** The slash command that ends the current conversation and starts a fresh one. */
  command: string;
  /** What the harness's own help calls it, so the findings can quote rather than paraphrase. */
  described: string;
};

/** Verified by reading each harness's command table, then driven live by `e3/reset-probe.ts`. */
export const RESET: Record<Harness, ResetPlan | null> = {
  claude: { command: "/clear", described: "Clear conversation history and free up context" },
  codex: { command: "/new", described: "start a new chat during a conversation" },
  pi: { command: "/new", described: "Start a new session" },
  cursor: { command: "/clear", described: "Start a new chat session" },
};

export type PoolConfig = {
  session: string;
  workspaceLabel: string;
  commandTimeoutMs: number;
  settleTimeoutMs: number;
  binDir?: string;
  cwd?: string;
  startAttempts?: number;
  startRetryMs?: number;
  /**
   * How the reset is waited on. `settle` submits it and sleeps `resetSettleMs`; `wait` uses
   * `agent prompt --wait`, which is slower but leaves nothing of the reset turn in flight.
   */
  resetMode?: "settle" | "wait";
  /** How long to let the TUI consume the reset before the next prompt. Default 1000ms. */
  resetSettleMs?: number;
  /** Upper bound for `resetMode: "wait"`. Herdr's own state-change window is a fixed 5s. */
  resetWaitMs?: number;
};

export type HerdrCall =
  | { ok: true; result: Record<string, unknown>; stdout: string; ms: number }
  | { ok: false; error: string; ms: number };

export type PooledPane = {
  name: string;
  /** What `workspace create` plus `agent start` cost, paid once for the whole pool. */
  setupMs: number;
  startAttempts: number;
  prompt(text: string): Promise<{ state: SettledState; ms: number; sessionRef?: string }>;
  read(): Promise<string | null>;
  /** Runs the harness's reset. `supported: false` means the table has no command for it. */
  reset(): Promise<{ supported: boolean; ok: boolean; ms: number; detail?: string }>;
  close(): Promise<void>;
};

export function poolDriver(config: PoolConfig, run: RunProcess = runProcess) {
  const startAttempts = config.startAttempts ?? 5;
  const startRetryMs = config.startRetryMs ?? 2_000;

  const herdr = async (args: string[], timeoutMs?: number): Promise<HerdrCall> => {
    const started = Date.now();
    const result = await run({
      argv: ["herdr", "--session", config.session, ...args],
      timeoutMs: timeoutMs ?? config.commandTimeoutMs,
    });
    const ms = Date.now() - started;
    if (result.exitCode !== 0) {
      return { ok: false, error: (result.stderr || result.stdout).trim().slice(0, 400), ms };
    }
    const line = result.stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (!line) return { ok: true, result: {}, stdout: result.stdout, ms };
    try {
      const parsed = JSON.parse(line) as { result?: Record<string, unknown> };
      return { ok: true, result: parsed.result ?? {}, stdout: result.stdout, ms };
    } catch {
      return { ok: true, result: {}, stdout: result.stdout, ms };
    }
  };

  return {
    async open(harness: Harness, label: string): Promise<PooledPane> {
      const spec = harnessSpec(harness);
      const name = `wf-pool-${label}`;
      const started = Date.now();

      const created = await herdr([
        "workspace",
        "create",
        "--label",
        `${config.workspaceLabel} ${label}`,
        ...(config.binDir ? ["--env", `PATH=${config.binDir}:${process.env.PATH ?? ""}`] : []),
        ...(config.cwd ? ["--cwd", config.cwd] : []),
        "--no-focus",
      ]);
      if (!created.ok) throw new Error(`workspace create failed: ${created.error}`);
      const paneId = readPaneId(created.result);
      const workspaceId = readId(created.result.workspace, "workspace_id");
      if (!paneId) throw new Error("workspace create returned no pane id");

      let attempts = 0;
      let startError = "agent start never ran";
      let ok = false;
      for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
        attempts = attempt;
        const args = spec.paneArgs();
        const call = await herdr(
          [
            "agent",
            "start",
            name,
            "--kind",
            spec.herdrKind,
            "--pane",
            paneId,
            "--timeout",
            "120000",
            ...(args.length > 0 ? ["--", ...args] : []),
          ],
          150_000,
        );
        if (call.ok) {
          ok = true;
          break;
        }
        startError = call.error;
        await Bun.sleep(startRetryMs);
      }
      if (!ok) {
        if (workspaceId) await herdr(["workspace", "close", workspaceId]);
        throw new Error(`agent start failed after ${attempts}: ${startError}`);
      }

      let sessionRef: string | undefined;

      const submit = async (text: string, timeoutMs: number) => {
        const call = await herdr(
          ["agent", "prompt", name, text, "--wait", "--timeout", String(timeoutMs)],
          timeoutMs + 30_000,
        );
        if (!call.ok) return { state: "unknown" as SettledState, ms: call.ms, error: call.error };
        const agent = record(call.result.agent) ?? call.result;
        sessionRef = readId(agent.agent_session, "value") ?? sessionRef;
        return { state: settledState(agent), ms: call.ms };
      };

      return {
        name,
        setupMs: Date.now() - started,
        startAttempts: attempts,
        async prompt(text: string) {
          const done = await submit(text, config.settleTimeoutMs);
          return { state: done.state, ms: done.ms, ...(sessionRef ? { sessionRef } : {}) };
        },
        async read() {
          const call = await herdr(["agent", "read", name, "--source", "detection"]);
          if (!call.ok) return null;
          return call.stdout.trim() === "" ? null : call.stdout;
        },
        async reset() {
          const plan = RESET[harness];
          if (!plan) return { supported: false, ok: false, ms: 0, detail: "no reset command" };
          const started = Date.now();
          if (config.resetMode === "wait") {
            const done = await submit(plan.command, config.resetWaitMs ?? 20_000);
            return {
              supported: true,
              // A slash command that never leaves `idle` answers `agent_prompt_stalled`. That
              // is Herdr not seeing a state change, not a reset that failed.
              ok: done.state !== "unknown" || (done.error ?? "").includes("agent_prompt_stalled"),
              ms: Date.now() - started,
              detail: done.error ?? done.state,
            };
          }
          const call = await herdr(["agent", "prompt", name, plan.command]);
          // Nothing observable says a slash command has been consumed. `--wait` burns its
          // fixed 5s state-change window and answers `agent_prompt_stalled` on three of the
          // four harnesses, and returning immediately lands the next prompt concatenated onto
          // the unconsumed command (`/clearWhat passphrase…`), measured both ways in
          // `reset-probe.ts` and `reset-latency.ts`. A fixed settle is the honest middle.
          await Bun.sleep(config.resetSettleMs ?? 1_000);
          return {
            supported: true,
            ok: call.ok,
            ms: Date.now() - started,
            detail: call.ok ? "submitted" : call.error,
          };
        },
        async close() {
          if (workspaceId) await herdr(["workspace", "close", workspaceId]);
        },
      };
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readId(value: unknown, key: string): string | undefined {
  const id = record(value)?.[key];
  return typeof id === "string" && id !== "" ? id : undefined;
}

function readPaneId(result: Record<string, unknown>): string | null {
  const direct = result.pane_id;
  if (typeof direct === "string") return direct;
  return readId(result.root_pane ?? result.pane, "pane_id") ?? null;
}

function settledState(result: Record<string, unknown>): SettledState {
  const status = result.agent_status ?? result.status ?? result.state;
  switch (typeof status === "string" ? status : "") {
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    default:
      return "unknown";
  }
}
