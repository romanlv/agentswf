import { runProcess, type RunProcess } from "../command";
import { harnessSpec } from "../spec";
import type {
  AgentSession,
  AgentSessionBackend,
  CallIdentity,
  SettledState,
  Step,
  TurnOutcome,
} from "../types";

export type PaneConfig = {
  /** Never `review-loop`: that session has a live loop attached to it. */
  session: string;
  workspaceLabel: string;
  commandTimeoutMs: number;
  settleTimeoutMs: number;
  binDir?: string;
  /** `agent start` refuses a pane that has not reached its shell prompt; see `startAgent`. */
  startAttempts?: number;
  startRetryMs?: number;
};

type HerdrResult =
  | { ok: true; result: Record<string, unknown>; stdout: string }
  | { ok: false; error: string };

/**
 * A workspace per call, closed after. Every Herdr verb the experiment uses is in this file and
 * every harness flag it passes through is in `harness.ts`.
 */
export function createPaneBackend(
  config: PaneConfig,
  run: RunProcess = runProcess,
): AgentSessionBackend {
  const startAttempts = config.startAttempts ?? 5;
  const startRetryMs = config.startRetryMs ?? 2_000;

  const herdr = async (args: string[], timeoutMs?: number): Promise<HerdrResult> => {
    const result = await run({
      argv: ["herdr", "--session", config.session, ...args],
      timeoutMs: timeoutMs ?? config.commandTimeoutMs,
    });
    if (result.exitCode !== 0) {
      return { ok: false, error: (result.stderr || result.stdout).trim().slice(0, 400) };
    }
    // `agent read` answers with terminal text; every other verb answers with a JSON envelope.
    const line = result.stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (!line) return { ok: true, result: {}, stdout: result.stdout };
    try {
      const parsed = JSON.parse(line) as { result?: Record<string, unknown> };
      return { ok: true, result: parsed.result ?? {}, stdout: result.stdout };
    } catch {
      return { ok: true, result: {}, stdout: result.stdout };
    }
  };

  /**
   * A pane created a moment ago has not reached its shell prompt and `agent start` refuses it
   * with `agent_pane_busy`. E1 saw that on 10 of 24 starts, always clearing on a retry, so the
   * retry is mandatory rather than defensive.
   */
  const startAgent = async (
    name: string,
    kind: string,
    paneId: string,
    args: string[],
  ): Promise<{ ok: boolean; attempts: number; error: string }> => {
    let error = "agent start never ran";
    for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
      const started = await herdr(
        [
          "agent",
          "start",
          name,
          "--kind",
          kind,
          "--pane",
          paneId,
          "--timeout",
          "120000",
          ...(args.length > 0 ? ["--", ...args] : []),
        ],
        150_000,
      );
      if (started.ok) return { ok: true, attempts: attempt, error: "" };
      error = started.error;
      await Bun.sleep(startRetryMs);
    }
    return { ok: false, attempts: startAttempts, error };
  };

  return {
    kind: "pane",
    async open(step: Step, call: CallIdentity): Promise<AgentSession> {
      const spec = harnessSpec(step.harness);
      const name = `wf-${call.callId}`;

      // The call id reaches the agent through the pane environment, so the prompt never has to
      // carry an id the agent might mangle.
      const created = await herdr([
        "workspace",
        "create",
        "--label",
        `${config.workspaceLabel} ${call.callId}`,
        "--env",
        `WF_RUN=${call.runDir}`,
        "--env",
        `WF_CALL=${call.callId}`,
        ...(config.binDir ? ["--env", `PATH=${config.binDir}:${process.env.PATH ?? ""}`] : []),
        ...(step.cwd ? ["--cwd", step.cwd] : []),
        "--no-focus",
      ]);
      if (!created.ok) throw new Error(`workspace create failed: ${created.error}`);
      const paneId = readPaneId(created.result);
      const workspaceId = readId(created.result.workspace, "workspace_id");
      if (!paneId) throw new Error("workspace create returned no pane id");

      const closeWorkspace = async () => {
        if (workspaceId) await herdr(["workspace", "close", workspaceId]);
      };

      const started = await startAgent(name, spec.herdrKind, paneId, spec.paneArgs(step.model));
      if (!started.ok) {
        await closeWorkspace();
        throw new Error(`agent start failed after ${started.attempts}: ${started.error}`);
      }

      let sessionRef: string | undefined;

      return {
        async prompt(text: string): Promise<TurnOutcome> {
          const sent = await herdr(
            [
              "agent",
              "prompt",
              name,
              text,
              "--wait",
              "--timeout",
              String(config.settleTimeoutMs),
            ],
            config.settleTimeoutMs + 30_000,
          );
          if (!sent.ok) return { state: "unknown", detail: sent.error };
          const agent = record(sent.result.agent) ?? sent.result;
          sessionRef = readSessionRef(agent) ?? sessionRef;
          return {
            state: settledState(agent),
            ...(statusText(agent) ? { detail: statusText(agent) } : {}),
            ...(sessionRef ? { sessionRef } : {}),
          };
        },
        /**
         * Agents run on the alternate screen and rows that leave it never enter scrollback, so
         * this read is best-effort by design. `delimited-line` on a pane is measuring that
         * limit as much as it is measuring the agent.
         */
        async transcript(): Promise<string | null> {
          const read = await herdr(["agent", "read", name, "--source", "detection"]);
          if (!read.ok) return null;
          return read.stdout.trim() === "" ? null : read.stdout;
        },
        async close(): Promise<void> {
          await closeWorkspace();
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

/** Herdr reports the harness's own session as `{ kind, value }`, not as a bare string. */
function readSessionRef(agent: Record<string, unknown>): string | undefined {
  return readId(agent.agent_session, "value");
}

function readPaneId(result: Record<string, unknown>): string | null {
  const direct = result.pane_id;
  if (typeof direct === "string") return direct;
  return readId(result.root_pane ?? result.pane, "pane_id") ?? null;
}

function statusText(result: Record<string, unknown>): string | undefined {
  const status = result.agent_status ?? result.status ?? result.state;
  return typeof status === "string" ? status : undefined;
}

/** Anything Herdr reports that we do not recognize is `unknown`, never `done`. */
function settledState(result: Record<string, unknown>): SettledState {
  switch (statusText(result)) {
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
