import type { Harness } from "./types";

export type TurnPlan = {
  argv: string[];
  /** The prompt goes on stdin everywhere: it is the one channel no CLI reinterprets. */
  stdin?: string;
};

export type TurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
};

/** A session id we choose ahead of the first turn, for a harness that will accept one. */
export type TurnContext = { model?: string; sessionHint: string };

export type HarnessSpec = {
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
  readSessionId?(stdout: string): string | null;
  /** What the agent actually printed, unwrapped from any envelope the harness adds. */
  readTranscript?(stdout: string): string;
  /** Tokens and, where the harness gives one, dollars for the turn just run. */
  readUsage?(stdout: string): TurnUsage;
};

type Row = Record<string, unknown>;

function jsonLines(stdout: string): Row[] {
  const rows: Row[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") rows.push(parsed as Row);
    } catch {
      // A partial line is not a result; the events that matter are complete ones.
    }
  }
  return rows;
}

function lastJson(stdout: string): Row | undefined {
  return jsonLines(stdout).at(-1);
}

function record(value: unknown): Row | undefined {
  return value && typeof value === "object" ? (value as Row) : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Claude bills the same turn twice over if the CLAUDE.md prefix misses cache; both are input. */
const claudeUsage = (stdout: string): TurnUsage => {
  const result = lastJson(stdout);
  const usage = record(result?.usage);
  return {
    inputTokens: num(usage?.input_tokens),
    outputTokens: num(usage?.output_tokens),
    cachedInputTokens:
      (num(usage?.cache_read_input_tokens) ?? 0) + (num(usage?.cache_creation_input_tokens) ?? 0),
    costUsd: num(result?.total_cost_usd),
  };
};

/**
 * Every harness's flags and output readers live in this table; the startup screens a pane shows
 * are Herdr's business and live in `adapters/herdr-startup.ts`. The flags are the ones E1 drove and
 * E2 re-drove live.
 */
export const HARNESSES: Record<Harness, HarnessSpec> = {
  claude: {
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
    readSessionId: (stdout) => str(lastJson(stdout)?.session_id),
    readTranscript: (stdout) => str(lastJson(stdout)?.result) ?? stdout,
    readUsage: claudeUsage,
  },

  codex: {
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
      return str(started?.thread_id);
    },
    readTranscript: (stdout) => {
      const messages = jsonLines(stdout)
        .filter((row) => str(record(row.item)?.type) === "agent_message")
        .map((row) => str(record(row.item)?.text) ?? "");
      return messages.join("\n") || stdout;
    },
    readUsage: (stdout) => {
      const completed = jsonLines(stdout).findLast((row) => row.type === "turn.completed");
      const usage = record(completed?.usage);
      return {
        inputTokens: num(usage?.input_tokens),
        outputTokens: num(usage?.output_tokens),
        cachedInputTokens: num(usage?.cached_input_tokens),
      };
    },
  },

  pi: {
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
      return str(session?.id);
    },
    readTranscript: (stdout) => {
      const end = jsonLines(stdout).findLast((row) => row.type === "turn_end");
      const message = record(end?.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content.map((part) => str(record(part)?.text) ?? "").join("");
      return text || stdout;
    },
    readUsage: (stdout) => {
      const end = jsonLines(stdout).findLast((row) => row.type === "turn_end");
      const usage = record(record(end?.message)?.usage);
      return {
        inputTokens: num(usage?.input),
        outputTokens: num(usage?.output),
        cachedInputTokens: num(usage?.cacheRead),
        costUsd: num(record(usage?.cost)?.total),
      };
    },
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
    readSessionId: (stdout) => str(lastJson(stdout)?.session_id),
    readTranscript: (stdout) => str(lastJson(stdout)?.result) ?? stdout,
    // No dollar figure anywhere: a cursor step is unpriceable, which E1 also found.
    readUsage: (stdout) => {
      const usage = record(lastJson(stdout)?.usage);
      return {
        inputTokens: num(usage?.inputTokens),
        outputTokens: num(usage?.outputTokens),
        cachedInputTokens: num(usage?.cacheReadTokens),
      };
    },
  },
};

export function harnessSpec(harness: Harness): HarnessSpec {
  return HARNESSES[harness];
}
