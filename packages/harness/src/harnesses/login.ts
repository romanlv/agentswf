import type { TurnLogin } from "@agentswf/contract/workflow";
import { jsonLines, record, text } from "../json";
import { readable } from "../screen";
import { lastJson } from "./shared";

/**
 * A login the harness lacks or had refused: the provider where it names one, and what it said, as
 * one line.
 */
export type LoginNeed = { provider?: string; said: string };

/**
 * How a harness shows it cannot sign in, and what fixes it. Each reads only what the harness itself
 * printed: an agent's own words may quote any of it, as one working on this file would.
 */
export type LoginCheck = {
  /** A headless turn's: its CLI's envelope and its stderr. */
  headless(stdout: string, stderr: string): LoginNeed | undefined;
  /** Its pane's screen, at launch or after a turn: a line the harness drew, past its glyph. */
  screen(screen: string): LoginNeed | undefined;
  /** What the operator runs to log in again. */
  run: string;
};

const SAID_CHARS = 300;

function said(words: string): string {
  const line = words.replace(/\s+/g, " ").trim();
  return line.length > SAID_CHARS ? `${line.slice(0, SAID_CHARS)}…` : line;
}

/**
 * What a pane shows after the prompt that carried `marker`, an operation's id: an earlier turn's
 * lines are that turn's, which a stale login line would fail this one on. Nothing where the id is
 * not drawn, as in a paste a harness folds away; all of it where no prompt was sent yet.
 */
export function thisTurn(screen: string, marker: string | undefined): string {
  if (marker === undefined) return screen;
  const at = screen.lastIndexOf(marker);
  return at === -1 ? "" : screen.slice(at);
}

/** The lines that start with one of `starts`, past its colour and the glyph the harness puts first. */
function drawn(screen: string, starts: RegExp): string | undefined {
  return readable(screen)
    .split("\n")
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, ""))
    .findLast((line) => starts.test(line));
}

// The reason may come first, as `Invalid API key · Please run /login` (an earlier claude).
const CLAUDE_SCREEN = /^(Not logged in · )?Please run \/login\b| · Please run \/login$/;

/**
 * claude 2.1.289: no login is `Not logged in · Please run /login`; a refused one is an API error of
 * 401, printed `Please run /login · API Error: 401 …` in its pane.
 */
export const claudeLogin: LoginCheck = {
  headless(stdout) {
    const result = lastJson(stdout);
    if (result?.type !== "result" || result.is_error !== true) return undefined;
    const words = text(result.result) ?? "";
    return result.api_error_status === 401 || /\/login\b/.test(words)
      ? { said: said(words || "API error 401") }
      : undefined;
  },
  screen(screen) {
    const line = drawn(screen, CLAUDE_SCREEN);
    return line ? { said: said(line) } : undefined;
  },
  run: "run `claude`, then /login; a sandboxed claude's CLAUDE_CODE_OAUTH_TOKEN comes from `claude setup-token`",
};

// A refresh that failed for any other reason, as on the network, may yet succeed on a retry.
const CODEX_REFRESH = /Failed to refresh token status=401|refresh_token_invalidated/;

/**
 * codex-cli 0.160.1: a refused refresh is logged on stderr by its auth manager; no login, or a
 * refused token, fails the turn with a 401 after its retries. Its TUI does not start a session
 * without one: it shows its sign-in screen.
 */
export const codexLogin: LoginCheck = {
  headless(stdout, stderr) {
    const rows = jsonLines(stdout);
    if (rows.some((row) => row.type === "turn.completed")) return undefined;
    const refresh = stderr.split("\n").find((line) => CODEX_REFRESH.test(line));
    if (refresh) {
      const message = /error_message: Some\("([^"]*)"\)/.exec(refresh)?.[1];
      return { said: said(message ?? refresh.replace(/^.*?Failed to refresh token/, "")) };
    }
    const failed = rows.findLast((row) => row.type === "turn.failed");
    const message = text(record(failed?.error)?.message);
    return message && /\b401\b|unauthorized/i.test(message) ? { said: said(message) } : undefined;
  },
  screen(screen) {
    const line = drawn(screen, /^Finish signing in via your browser/);
    return line ? { said: said(line) } : undefined;
  },
  run: "run `codex login`",
};

const CURSOR_REFUSED =
  /^(Error: Authentication required\.|Warning: The provided API key is invalid\.)/;

/**
 * cursor-agent 2026.10.01: no login and a refused API key each exit 1 with a line on stderr; its
 * TUI shows its sign-in screen without a login, and exits with the same line on a refused key.
 */
export const cursorLogin: LoginCheck = {
  headless(_stdout, stderr) {
    const line = drawn(stderr, CURSOR_REFUSED);
    return line ? { said: said(line) } : undefined;
  },
  screen(screen) {
    const line = drawn(
      screen,
      /^(Signing in with the browser|Warning: The provided API key is invalid\.)/,
    );
    return line ? { said: said(line) } : undefined;
  },
  run: "run `cursor-agent login`; a sandboxed cursor's CURSOR_API_KEY comes from its dashboard",
};

const PI_NO_KEY = /^(?:Error: )?No API key found for (\S+?)\.(?:\s|$)/;
const PI_REFRESH = /^(?:Error: )?OAuth refresh failed for ([^\s:]+):/;

/**
 * pi 0.87.1: no login for the model's provider exits 1 with `No API key found for {provider}.` on
 * stderr; a refused refresh exits 0 with a turn that ended in `OAuth refresh failed for {provider}`.
 */
export const piLogin: LoginCheck = {
  headless(stdout, stderr) {
    const missing = stderr
      .split("\n")
      .map((line) => PI_NO_KEY.exec(line))
      .find(Boolean);
    if (missing) return { provider: missing[1]!, said: said(missing[0]) };
    const end = jsonLines(stdout).findLast((row) => row.type === "turn_end");
    const message = record(end?.message);
    const error = message?.stopReason === "error" ? text(message.errorMessage) : undefined;
    const refused = error ? PI_REFRESH.exec(error) : null;
    return refused ? { provider: refused[1]!, said: said(error!) } : undefined;
  },
  screen(screen) {
    const line = drawn(screen, /^Error: (No API key found for|OAuth refresh failed for) /);
    const provider = line && (PI_NO_KEY.exec(line) ?? PI_REFRESH.exec(line))?.[1];
    return line ? { ...(provider ? { provider } : {}), said: said(line) } : undefined;
  },
  run: "run `pi`, then /login",
};

/** The failed turn `read` finds in what the harness printed; undefined where it finds no login. */
export function failedOnLogin(
  harness: string,
  check: LoginCheck | undefined,
  read: (check: LoginCheck) => LoginNeed | undefined,
): { state: "failed"; detail: string; login: TurnLogin } | undefined {
  const need = check && read(check);
  return check && need ? { state: "failed", ...loginFailure(harness, check, need) } : undefined;
}

/** The reason a turn that needs a login ends with, and what the workflow is told of it. */
export function loginFailure(
  harness: string,
  check: LoginCheck,
  need: LoginNeed,
): { detail: string; login: TurnLogin } {
  const whose = need.provider ? ` for ${need.provider}` : "";
  return {
    detail: `${harness} needs a login${whose}: ${check.run} (${harness} said: ${need.said})`,
    login: { harness, ...(need.provider ? { provider: need.provider } : {}), run: check.run },
  };
}
