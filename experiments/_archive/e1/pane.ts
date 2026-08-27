import { HARNESSES, type HarnessName } from "./harnesses";
import { herdr } from "./herdr";
import { CWD } from "./headless";

export type PaneRun = {
  ok: boolean;
  /** Wall clock of the `agent start` call that succeeded. */
  startMs?: number;
  /** From the first attempt, so the cost of waiting for a shell prompt is visible. */
  startTotalMs?: number;
  startAttempts?: number;
  startError: string;
  promptMs?: number;
  promptError: string;
  /** What `--wait` reported once it returned. */
  settledStatus: string;
  settledTitle: string;
  /** True when the reply appeared without send-keys — the claim under test. */
  landedOnWaitAlone: boolean;
  /** True when a follow-up Enter was what made the reply appear. */
  neededEnter: boolean;
  tail: string;
};

const START_TIMEOUT_MS = 120_000;
const START_ATTEMPTS = 5;
const START_RETRY_MS = 2_000;

export async function runPane(
  name: HarnessName,
  prompt: string,
  answered: (terminal: string) => boolean,
  promptTimeoutMs: number,
): Promise<PaneRun> {
  const agent = `e1-${name}-${Date.now()}`;
  const created = await herdr([
    "workspace",
    "create",
    "--cwd",
    CWD,
    "--label",
    `e1 ${name}`,
  ]);
  const paneId = str(rec(created.result?.root_pane)?.pane_id);
  const workspaceId = str(rec(created.result?.workspace)?.workspace_id);
  if (!paneId) {
    return blank(`workspace create failed: ${created.error}`);
  }

  try {
    const start = await startAgent(agent, HARNESSES[name].kind, paneId);
    if (!start.ok) {
      return {
        ...blank(start.error),
        startMs: start.ms,
        startTotalMs: start.totalMs,
        startAttempts: start.attempts,
      };
    }

    const prompted = await herdr(
      ["agent", "prompt", agent, prompt, "--wait", "--timeout", String(promptTimeoutMs)],
      promptTimeoutMs + 30_000,
    );
    const settled = rec(prompted.result?.agent);
    const afterWait = await read(agent);
    const landedOnWaitAlone = answered(afterWait);

    // Only asked for when `--wait` did not produce the answer: this is the dance under test.
    let neededEnter = false;
    let tail = afterWait;
    if (!landedOnWaitAlone) {
      await herdr(["agent", "send-keys", agent, "enter"]);
      await herdr(["agent", "wait", agent, "--timeout", String(promptTimeoutMs)], promptTimeoutMs + 30_000);
      tail = await read(agent);
      neededEnter = answered(tail);
    }

    return {
      ok: landedOnWaitAlone || neededEnter,
      startMs: start.ms,
      startTotalMs: start.totalMs,
      startAttempts: start.attempts,
      startError: "",
      promptMs: prompted.ms,
      promptError: prompted.ok ? "" : prompted.error,
      settledStatus: str(settled?.agent_status),
      settledTitle: str(settled?.terminal_title),
      landedOnWaitAlone,
      neededEnter,
      tail: tail.slice(-600),
    };
  } finally {
    if (workspaceId) await herdr(["workspace", "close", workspaceId]);
  }
}

/**
 * A pane created a moment ago has not reached its shell prompt, and `agent start` refuses it with
 * `agent_pane_busy`. Retrying is the only way in; how often it is needed is part of the result.
 */
async function startAgent(
  agent: string,
  kind: string,
  paneId: string,
): Promise<{ ok: boolean; ms: number; totalMs: number; attempts: number; error: string }> {
  const began = Date.now();
  let last = { ok: false, ms: 0, error: "agent start never ran" };
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
    const call = await herdr([
      "agent",
      "start",
      agent,
      "--kind",
      kind,
      "--pane",
      paneId,
      "--timeout",
      String(START_TIMEOUT_MS),
    ]);
    last = { ok: call.ok, ms: call.ms, error: call.error };
    if (call.ok) {
      return { ...last, totalMs: Date.now() - began, attempts: attempt };
    }
    await Bun.sleep(START_RETRY_MS);
  }
  return { ...last, totalMs: Date.now() - began, attempts: START_ATTEMPTS };
}

/** `agent read` answers with the terminal text itself, not the JSON envelope every other call uses. */
async function read(agent: string): Promise<string> {
  return (await herdr(["agent", "read", agent, "--lines", "80"])).stdout;
}

function blank(startError: string): PaneRun {
  return {
    ok: false,
    startError,
    promptError: "",
    settledStatus: "",
    settledTitle: "",
    landedOnWaitAlone: false,
    neededEnter: false,
    tail: "",
  };
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
