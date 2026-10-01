import { basename, join } from "node:path";
import type { Billing } from "@agentswf/contract/records";
import type { AgentPlacement } from "@agentswf/contract/workflow";
import type { Holding, RunProcess } from "./command";
import { jsonLines, parseRow, type Row, record, reported, text } from "./json";
import type { Harness } from "./types";
import { readClaudeBilling, readCodexBilling, readPiBilling } from "./usage/billing";
import { claudeProjectsDirectory, readClaudeCompactSummary, readClaudeUsage } from "./usage/claude";
import { codexSessionsDirectory, readCodexUsage } from "./usage/codex";
import { ownFiles } from "./usage/files";
import { readPiUsage } from "./usage/pi";
import type { SessionRead } from "./usage/records";

export type TurnPlan = {
  argv: string[];
  /** The prompt goes on stdin everywhere: it is the one channel no CLI reinterprets. */
  stdin?: string;
  /** The session this turn runs under, when the plan chose it rather than the harness. */
  sessionId?: string;
};

/** A headless run of the harness's own compaction; see `HarnessSpec.compactHeadless`. */
export type CompactionPlan = TurnPlan &
  Holding & {
    /** What its output says: the summary, `""` where the harness keeps it opaque, or why not. */
    read(stdout: string): { summary: string } | { error: string };
  };

export type BillingContext = {
  model?: string;
  /** The provider the harness logged, where it logs one. */
  provider?: string;
  /** How the host launches agents, so a status command sees the credentials they get. */
  run: RunProcess;
};

/**
 * A session id we choose ahead of the first turn, for a harness that will accept one, and the
 * arguments the launch adds, a sandbox's and the agent's skills', which each plan puts where they
 * cannot swallow what follows.
 */
export type TurnContext = {
  model?: string;
  sessionHint: string;
  launchArgs?: readonly string[];
};

export type HarnessSpec = {
  /** The variable the harness sets in its agent's shell to name the native session. */
  sessionEnv?: string;
  /**
   * A retained interactive launch, independent of the terminal provider that hosts it, with the
   * arguments its launch adds last, where nothing follows to be swallowed.
   */
  interactive(model?: string, launchArgs?: readonly string[]): TurnPlan;
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
  readSessionUsage?(
    sessions: readonly string[],
    cwd: string,
    /** The agent's own harness home when it ran in a sandbox; the operator's otherwise. */
    home?: string,
  ): Promise<SessionRead | undefined>;
  /**
   * Every session in a harness home the agent had alone, as `readSessionUsage` takes them: a
   * sandboxed agent's own home holds nothing else, and a pane's harness names its session to
   * nobody when it never calls `wf` (story 004, "Panes").
   */
  homeSessions?(home: string): Promise<string[]>;
  /** Whether this agent's tokens are charged, which is not always what its login says. */
  billing?(context: BillingContext): Promise<Billing>;
  /**
   * Its own compaction of a headless session, with `focus` as what to keep and drop (ADR 0007).
   * Absent where it has none: a compaction then fails before anything runs.
   */
  compactHeadless?(focus: string, sessionId: string, context: TurnContext): CompactionPlan;
  /** Its own compaction in a pane: what is typed, in order, and the screen that shows it ran. */
  compactPane?: {
    prompts(focus: string): string[];
    /** Whether `screen` shows a compaction after what this one's prompts put there. */
    compacted(screen: string, focus: string): boolean;
  };
  /** The summary of a session's last compaction, from the harness's own record, where it keeps one. */
  readCompactSummary?(sessionId: string, cwd: string): Promise<string | undefined>;
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
    interactive: (model, launchArgs = []) => ({
      argv: [
        "claude",
        "--allowed-tools",
        "Bash",
        ...(model ? ["--model", model] : []),
        ...launchArgs,
      ],
    }),
    // `--output-format json` is the only place the resumable session id is printed, and
    // without it there is no headless nudge.
    headlessTurn: (prompt, { model, launchArgs = [] }) => ({
      argv: [
        "claude",
        "-p",
        ...launchArgs,
        "--output-format",
        "json",
        "--allowed-tools",
        "Bash",
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    }),
    resumeTurn: (prompt, sessionId, { model, launchArgs = [] }) => ({
      argv: [
        "claude",
        "-p",
        "--resume",
        sessionId,
        ...launchArgs,
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
    // Only `stream-json` prints the compaction: its boundary, then the summary as a synthetic
    // user row. `json` prints an empty result either way.
    compactHeadless: (focus, sessionId, { model, launchArgs = [] }) => ({
      argv: [
        "claude",
        "-p",
        "--resume",
        sessionId,
        ...launchArgs,
        "--output-format",
        "stream-json",
        "--verbose",
        ...(model ? ["--model", model] : []),
      ],
      stdin: `/compact ${focus}`,
      read: (stdout) => {
        const rows = jsonLines(stdout);
        const boundary = rows.findIndex(
          (row) => row.type === "system" && row.subtype === "compact_boundary",
        );
        if (boundary < 0) {
          const result = text(lastJson(stdout)?.result);
          return {
            error: `claude wrote no compaction${result ? `: ${result.slice(0, 300)}` : ""}`,
          };
        }
        const summary = rows
          .slice(boundary + 1)
          .find((row) => row.type === "user" && row.isSynthetic === true);
        return { summary: text(record(summary?.message)?.content) ?? "" };
      },
    }),
    compactPane: {
      prompts: (focus) => [`/compact ${focus}`],
      compacted: (screen) => after(screen, "/compact").includes("Compacted"),
    },
    readCompactSummary: (sessionId, cwd) => readClaudeCompactSummary(sessionId, cwd),
    readSessionUsage: (sessions, cwd, home) =>
      readClaudeUsage(sessions, cwd, claudeProjectsDirectory(home)),
    homeSessions: async (home) =>
      (await ownFiles(home, claudeProjectsDirectory(home)))
        .filter((name) => /^[^/]+\/[^/]+\.jsonl$/.test(name))
        .map((name) => basename(name, ".jsonl")),
    // E3: `claude -p` bills metered on a subscription login, with no key in the environment.
    meteredHeadless: true,
    billing: ({ run }) => readClaudeBilling(run),
  },

  codex: {
    sessionEnv: "CODEX_SESSION_ID",
    interactive: (model, launchArgs = []) => ({
      argv: [
        "codex",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "never",
        ...(model ? ["--model", model] : []),
        ...launchArgs,
      ],
    }),
    // `exec resume` takes no `-s`, so the sandbox is set through `-c` on both turns rather
    // than through a flag that exists on only one of them.
    headlessTurn: (prompt, { model, launchArgs = [] }) => ({
      argv: [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="danger-full-access"',
        ...launchArgs,
        ...(model ? ["--model", model] : []),
        "-",
      ],
      stdin: prompt,
    }),
    resumeTurn: (prompt, sessionId, { model, launchArgs = [] }) => ({
      argv: [
        "codex",
        "exec",
        "resume",
        sessionId,
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="danger-full-access"',
        ...launchArgs,
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
    // `exec` sends `/compact` to the model as text; the app-server compacts, and exits once its
    // stdin closes. It takes no focus, and an OpenAI login ignores `compact_prompt`, so the focus
    // goes in as a user message first, which the compaction reads and keeps.
    compactHeadless: (focus, sessionId, { model, launchArgs = [] }) => {
      const request = (id: number, method: string, params: object) =>
        JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const requests = [
        request(1, "initialize", { clientInfo: { name: "awf", version: "0" } }),
        JSON.stringify({ jsonrpc: "2.0", method: "initialized" }),
        request(2, "thread/resume", {
          threadId: sessionId,
          excludeTurns: true,
          ...(model ? { model } : {}),
        }),
        request(3, "thread/inject_items", {
          threadId: sessionId,
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: codexCompactionFocus(focus) }],
            },
          ],
        }),
        request(4, "thread/compact/start", { threadId: sessionId }),
      ];
      const failedRequest = (row: Row) => row.error !== undefined && row.id !== 1;
      return {
        argv: [
          "codex",
          "app-server",
          "--listen",
          "stdio://",
          "-c",
          'sandbox_mode="danger-full-access"',
          ...launchArgs,
        ],
        stdin: `${requests.join("\n")}\n`,
        holdStdinUntil: (line) => {
          const row = parseRow(line);
          return row !== undefined && (row.method === "turn/completed" || failedRequest(row));
        },
        read: (stdout) => {
          const rows = jsonLines(stdout);
          const refused = rows.find(failedRequest);
          if (refused) {
            return {
              error: `codex refused: ${text(record(refused.error)?.message) ?? "an error"}`,
            };
          }
          const turn = record(
            record(rows.find((row) => row.method === "turn/completed")?.params)?.turn,
          );
          const compacted = rows.some(
            (row) =>
              row.method === "item/completed" &&
              text(record(record(row.params)?.item)?.type) === "contextCompaction",
          );
          if (turn?.status === "completed" && compacted) return { summary: "" };
          return {
            error: `codex did not compact${turn ? `: its turn ${text(turn.status) ?? "ended"}` : ""}`,
          };
        },
      };
    },
    // `/compact` takes no text in codex's TUI: the text would go to the model. Nor is it echoed,
    // so the focus message is what the compaction must show after.
    compactPane: {
      prompts: (focus) => [codexCompactionFocus(focus), "/compact"],
      compacted: (screen) => after(screen, CODEX_FOCUS_END).includes("Context compacted"),
    },
    readSessionUsage: (sessions, _cwd, home) =>
      readCodexUsage(sessions, codexSessionsDirectory(home)),
    // By start time, which a rollout's name begins with: a root session starts before the
    // subagents it delegates to, and usage counts the first session it reads as the agent's own.
    homeSessions: async (home) =>
      (await ownFiles(home, codexSessionsDirectory(home)))
        .map((name) => basename(name))
        .sort()
        .flatMap(
          (name) =>
            /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(name)?.[1] ?? [],
        ),
    // A ChatGPT login pays for OpenAI's models only; another provider bills on its own terms.
    billing: ({ provider, run }) =>
      provider && provider !== "openai" ? Promise.resolve("unknown") : readCodexBilling(run),
  },

  pi: {
    sessionEnv: "PI_SESSION_ID",
    interactive: (model, launchArgs = []) => ({
      argv: ["pi", ...(model ? ["--model", model] : []), ...launchArgs],
    }),
    // pi is the one harness whose session id we choose: `--session-id` creates it on the first
    // turn and reuses it on the second, so no id has to be scraped back out of the output.
    headlessTurn: (prompt, { model, sessionHint, launchArgs = [] }) => ({
      argv: [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-id",
        sessionHint,
        ...launchArgs,
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
      sessionId: sessionHint,
    }),
    resumeTurn: (prompt, sessionId, { model, launchArgs = [] }) => ({
      argv: [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-id",
        sessionId,
        ...launchArgs,
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
    // `--print` sends `/compact` to the model as text; rpc mode compacts, and exits once its
    // stdin closes.
    compactHeadless: (focus, sessionId, { model, launchArgs = [] }) => {
      const answer = (row: Row | undefined) =>
        row?.type === "response" && row.command === "compact";
      return {
        argv: [
          "pi",
          "--mode",
          "rpc",
          "--session-id",
          sessionId,
          ...launchArgs,
          ...(model ? ["--model", model] : []),
        ],
        stdin: `${JSON.stringify({ type: "compact", customInstructions: focus })}\n`,
        holdStdinUntil: (line) => answer(parseRow(line)),
        read: (stdout) => {
          const response = jsonLines(stdout).find(answer);
          if (response?.success === true) {
            return { summary: text(record(response.data)?.summary) ?? "" };
          }
          return { error: `pi did not compact: ${text(response?.error) ?? "no answer"}` };
        },
      };
    },
    readSessionUsage: (sessions, _cwd, home) => readPiUsage(sessions, home),
    homeSessions: async (home) => {
      const root = join(home, "sessions");
      return (await ownFiles(home, root))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(root, name));
    },
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

const CODEX_FOCUS_END = "Reply only: ok";

/** Codex compacts with no focus of its own, so it reads one as the message just before. */
function codexCompactionFocus(focus: string): string {
  return `Your context is about to be compacted. For its summary: ${focus}\n\n${CODEX_FOCUS_END}`;
}

/** What `screen` shows after the last line holding `marker`, or nothing when none does. */
function after(screen: string, marker: string): string {
  const at = screen.lastIndexOf(marker);
  return at < 0 ? "" : screen.slice(at + marker.length);
}

export function harnessSpec(harness: Harness): HarnessSpec {
  return HARNESSES[harness];
}

/** For a caller holding only a harness name, which may be one this table does not know. */
export function findHarness(harness: string): HarnessSpec | undefined {
  return Object.hasOwn(HARNESSES, harness) ? HARNESSES[harness as Harness] : undefined;
}

export const HARNESS_NAMES = Object.keys(HARNESSES) as [Harness, ...Harness[]];

/**
 * The harnesses each placement's run host runs. A pane is claude or codex, the two whose startup
 * screens are driven; a headless turn is any harness in the table.
 */
export const PLACEMENT_HARNESSES = {
  pane: ["claude", "codex"],
  headless: HARNESS_NAMES,
} as const satisfies Record<AgentPlacement, readonly [Harness, ...Harness[]]>;

export function knownHarness(value: string): Harness {
  if (findHarness(value)) return value as Harness;
  throw new Error(`unsupported harness: ${value}`);
}
