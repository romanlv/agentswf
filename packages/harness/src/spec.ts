import type { Billing } from "@wf/contract/records";
import type { RunProcess } from "./command";
import { jsonLines, type Row, record, reported, text } from "./json";
import type { Harness } from "./types";
import { readClaudeBilling, readCodexBilling, readPiBilling } from "./usage/billing";
import { readClaudeUsage } from "./usage/claude";
import { readCodexUsage } from "./usage/codex";
import { readPiUsage } from "./usage/pi";
import type { SessionRead } from "./usage/records";

export type TurnPlan = {
  argv: string[];
  /** The prompt goes on stdin everywhere: it is the one channel no CLI reinterprets. */
  stdin?: string;
  /** The session this turn runs under, when the plan chose it rather than the harness. */
  sessionId?: string;
};

export type BillingContext = {
  model?: string;
  /** The provider the harness logged, where it logs one. */
  provider?: string;
  /** How the host launches agents, so a status command sees the credentials they get. */
  run: RunProcess;
};

/** A session id we choose ahead of the first turn, for a harness that will accept one. */
export type TurnContext = { model?: string; sessionHint: string };

export type HarnessSpec = {
  /** The variable the harness sets in its agent's shell to name the native session. */
  sessionEnv?: string;
  /** A retained interactive launch, independent of the terminal provider that hosts it. */
  interactive(model?: string): TurnPlan;
  /** A one-shot, non-interactive run of `prompt`. */
  headlessTurn(prompt: string, context: TurnContext): TurnPlan;
  /**
   * A follow-up turn against the session the previous run left behind. Absent where the
   * harness has no resume we have confirmed — a headless nudge is impossible there, which is
   * itself an E2 result rather than something to paper over.
   */
  resumeTurn?(prompt: string, sessionId: string, context: TurnContext): TurnPlan;
  /** Pulls a resumable session id out of the harness's own output. */
  readSessionId?(stdout: string): string | undefined;
  /** What the agent actually printed, unwrapped from any envelope the harness adds. */
  readTranscript?(stdout: string): string;
  /**
   * The dollars the harness printed for the turn just run, where it prints any. Tokens are read
   * from its session files instead, by `readSessionUsage`.
   */
  readCharge?(stdout: string): number | undefined;
  /**
   * Every request logged in these sessions, read from the harness's own files, and whether a turn
   * is still being written. `undefined` when none of them could be found, which is unknown rather
   * than zero.
   */
  readSessionUsage?(sessions: readonly string[], cwd: string): Promise<SessionRead | undefined>;
  /** Whether this agent's tokens are charged, which is not always what its login says. */
  billing?(context: BillingContext): Promise<Billing>;
  /**
   * Its headless turns are billed per token even on a subscription login, so a headless agent is
   * `metered` whatever `billing` says, and runs only when its execution says `metered`.
   */
  meteredHeadless?: true;
};

function lastJson(stdout: string): Row | undefined {
  return jsonLines(stdout).at(-1);
}

/**
 * Every harness's flags and output readers live in this table; the startup screens a pane shows
 * are Herdr's business and live in `adapters/herdr-startup.ts`. The flags are the ones E1 drove and
 * E2 re-drove live.
 */
export const HARNESSES: Record<Harness, HarnessSpec> = {
  claude: {
    sessionEnv: "CLAUDE_CODE_SESSION_ID",
    // `Bash` has to be allowed or the agent cannot run `wf` at all, which would measure the
    // permission prompt rather than the return channel.
    interactive: (model) => ({
      argv: ["claude", "--allowed-tools", "Bash", ...(model ? ["--model", model] : [])],
    }),
    // `--output-format json` is the only place the resumable session id is printed, and
    // without it there is no headless nudge.
    headlessTurn: (prompt, { model }) => ({
      argv: [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--allowed-tools",
        "Bash",
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    }),
    resumeTurn: (prompt, sessionId, { model }) => ({
      argv: [
        "claude",
        "-p",
        "--resume",
        sessionId,
        "--output-format",
        "json",
        "--allowed-tools",
        "Bash",
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    }),
    readSessionId: (stdout) => text(lastJson(stdout)?.session_id),
    readTranscript: (stdout) => text(lastJson(stdout)?.result) ?? stdout,
    readCharge: (stdout) => reported(lastJson(stdout)?.total_cost_usd),
    readSessionUsage: (sessions, cwd) => readClaudeUsage(sessions, cwd),
    // E3: `claude -p` bills metered on a subscription login, with no key in the environment.
    meteredHeadless: true,
    billing: ({ run }) => readClaudeBilling(run),
  },

  codex: {
    sessionEnv: "CODEX_SESSION_ID",
    interactive: (model) => ({
      argv: [
        "codex",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "never",
        ...(model ? ["--model", model] : []),
      ],
    }),
    // `exec resume` takes no `-s`, so the sandbox is set through `-c` on both turns rather
    // than through a flag that exists on only one of them.
    headlessTurn: (prompt, { model }) => ({
      argv: [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="danger-full-access"',
        ...(model ? ["--model", model] : []),
        "-",
      ],
      stdin: prompt,
    }),
    resumeTurn: (prompt, sessionId, { model }) => ({
      argv: [
        "codex",
        "exec",
        "resume",
        sessionId,
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="danger-full-access"',
        ...(model ? ["--model", model] : []),
        "-",
      ],
      stdin: prompt,
    }),
    readSessionId: (stdout) => {
      const started = jsonLines(stdout).find((row) => row.type === "thread.started");
      return text(started?.thread_id);
    },
    readTranscript: (stdout) => {
      const messages = jsonLines(stdout)
        .filter((row) => text(record(row.item)?.type) === "agent_message")
        .map((row) => text(record(row.item)?.text) ?? "");
      return messages.join("\n") || stdout;
    },
    readSessionUsage: (sessions) => readCodexUsage(sessions),
    // A ChatGPT login pays for OpenAI's models only; another provider bills on its own terms.
    billing: ({ provider, run }) =>
      provider && provider !== "openai" ? Promise.resolve("unknown") : readCodexBilling(run),
  },

  pi: {
    sessionEnv: "PI_SESSION_ID",
    interactive: (model) => ({ argv: ["pi", ...(model ? ["--model", model] : [])] }),
    // pi is the one harness whose session id we choose: `--session-id` creates it on the first
    // turn and reuses it on the second, so no id has to be scraped back out of the output.
    headlessTurn: (prompt, { model, sessionHint }) => ({
      argv: [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-id",
        sessionHint,
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
      sessionId: sessionHint,
    }),
    resumeTurn: (prompt, sessionId, { model }) => ({
      argv: [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-id",
        sessionId,
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    }),
    readSessionId: (stdout) => {
      const session = jsonLines(stdout).find((row) => row.type === "session");
      return text(session?.id);
    },
    readTranscript: (stdout) => {
      const end = jsonLines(stdout).findLast((row) => row.type === "turn_end");
      const message = record(end?.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const said = content.map((part) => text(record(part)?.text) ?? "").join("");
      return said || stdout;
    },
    // pi's own list-price estimate, even on a subscription; a charge only when billed per token.
    readCharge: (stdout) => {
      const end = jsonLines(stdout).findLast((row) => row.type === "turn_end");
      return reported(record(record(record(end?.message)?.usage)?.cost)?.total);
    },
    readSessionUsage: (sessions) => readPiUsage(sessions),
    billing: ({ model, provider }) => readPiBilling(model, provider),
  },

  cursor: {
    interactive: (model) => ({
      argv: ["cursor-agent", "--force", ...(model ? ["--model", model] : [])],
    }),
    headlessTurn: (prompt, { model }) => ({
      argv: [
        "cursor-agent",
        "-p",
        "--output-format",
        "json",
        "--force",
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    }),
    resumeTurn: (prompt, sessionId, { model }) => ({
      argv: [
        "cursor-agent",
        "-p",
        "--output-format",
        "json",
        "--force",
        "--resume",
        sessionId,
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    }),
    readSessionId: (stdout) => text(lastJson(stdout)?.session_id),
    readTranscript: (stdout) => text(lastJson(stdout)?.result) ?? stdout,
    // No dollar figure anywhere: a cursor step is unpriceable, which E1 also found.
  },
};

export function harnessSpec(harness: Harness): HarnessSpec {
  return HARNESSES[harness];
}

/** For a caller holding only a harness name, which may be one this table does not know. */
export function findHarness(harness: string): HarnessSpec | undefined {
  return Object.hasOwn(HARNESSES, harness) ? HARNESSES[harness as Harness] : undefined;
}

export const HARNESS_NAMES = Object.keys(HARNESSES) as [Harness, ...Harness[]];

export function knownHarness(value: string): Harness {
  if (findHarness(value)) return value as Harness;
  throw new Error(`unsupported harness: ${value}`);
}
