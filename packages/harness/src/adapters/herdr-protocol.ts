import { createHash } from "node:crypto";
import { localOutcome } from "../session-core";
import type { SettledState } from "../types";

export type HerdrResult =
  | { ok: true; result: Record<string, unknown>; stdout: string }
  | { ok: false; error: string; timedOut: boolean; cancelled: boolean };

/** One Herdr invocation, already bound to a session. */
export type HerdrCommand = (
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<HerdrResult>;

/**
 * Herdr reports the settled agent itself; the process kill is only a backstop for a herdr that
 * never returns. Without slack the kill lands on the same tick as the report, and an agent that
 * used its whole settle window is misread as a timeout with its transcript, session ref and usage
 * discarded.
 */
export const HERDR_REPORT_GRACE_MS = 30_000;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function readId(value: unknown, key: string): string | undefined {
  const id = record(value)?.[key];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Herdr reports the harness's own session as `{ kind, value }`, not as a bare string. */
export function readSessionRef(agent: Record<string, unknown>): string | undefined {
  return readId(agent.agent_session, "value");
}

export function readPaneId(result: Record<string, unknown>): string | null {
  const direct = result.pane_id;
  if (typeof direct === "string") return direct;
  return readId(result.root_pane ?? result.pane, "pane_id") ?? null;
}

function statusText(result: Record<string, unknown>): string | undefined {
  const status = result.agent_status ?? result.status ?? result.state;
  return typeof status === "string" ? status : undefined;
}

/** Anything Herdr reports that we do not recognize is `unknown`, never `done`. */
export function settledState(result: Record<string, unknown>): SettledState {
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

/**
 * A pane screen and Herdr's own stderr both carry terminal control bytes. The content is not
 * secret, but a record holding raw escape sequences restyles every terminal that later prints it.
 */
export function readable(text: string): string {
  return (
    text
      .replace(ANSI_SEQUENCE, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  );
}

export const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

function herdrErrorCode(error: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(error);
    return readId(record(parsed)?.error, "code");
  } catch {
    return undefined;
  }
}

/**
 * The envelope is truncated to 400 characters and may carry a preamble, so a parse failure is
 * ordinary and no decision can depend on one. The raw fallback matches the code field, never a
 * message that merely names the code: the prompt argv carries workflow-authored text that can
 * quote a code straight back.
 */
export function hasHerdrErrorCode(error: string, code: string): boolean {
  const parsed = herdrErrorCode(error);
  if (parsed !== undefined) return parsed === code;
  return new RegExp(`"code"\\s*:\\s*"${code}"`).test(error) || error.trim() === code;
}

const RESERVED_WORKSPACE_ENVIRONMENT = new Set(["PATH", "WF_RUN", "WF_CALL"]);

export function emptyEnvironmentArgs(names: readonly string[] | undefined): string[] {
  const args: string[] = [];
  for (const name of names ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid Herdr workspace environment name: ${name}`);
    }
    if (RESERVED_WORKSPACE_ENVIRONMENT.has(name)) {
      throw new Error(`Herdr workspace environment is adapter-owned: ${name}`);
    }
    args.push("--env", `${name}=`);
  }
  return args;
}

export function safeAgentName(value: string, identity = value): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const rooted = /^[a-z]/.test(normalized) ? normalized : `a-${normalized}`;
  if (rooted === value && rooted.length <= 32 && identity === value) return rooted;

  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const prefix = rooted.slice(0, 19).replace(/[-_]+$/, "");
  return `${prefix}-${suffix}`;
}

/** The terminal state an agent's own settled status proves, before any evidence is attached. */
export function settledOutcome(agent: Record<string, unknown>): {
  state: "completed" | "blocked" | "failed";
  detail?: string;
} {
  const status = statusText(agent);
  switch (settledState(agent)) {
    case "idle":
    case "done":
      return { state: "completed", ...(status ? { detail: status } : {}) };
    case "blocked":
      return { state: "blocked", ...(status ? { detail: status } : {}) };
    case "unknown":
      return { state: "failed", detail: status ?? "unknown agent status" };
  }
}

export function herdrFailure(result: Extract<HerdrResult, { ok: false }>, remainingMs: number) {
  if (result.cancelled) return localOutcome("cancelled", "pane operation cancelled");
  if (result.timedOut || remainingMs <= 0) {
    return localOutcome("timed-out", "pane operation timed out");
  }
  return localOutcome("failed", result.error);
}

/**
 * The clamp matters: this carries a whole operation deadline, and a `setTimeout` above 2^31−1 ms
 * fires at once, which would read as an expired wait.
 */
export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve(true);
      },
      Math.min(milliseconds, 2_147_483_647),
    );
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
