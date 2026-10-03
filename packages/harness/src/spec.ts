import { basename, join } from "node:path";
import type { Billing } from "@agentswf/contract/records";
import type { AgentPlacement } from "@agentswf/contract/workflow";
import type { Holding, RunProcess } from "./command";
import { count, jsonLines, parseRow, type Row, record, reported, text } from "./json";
import type { Harness } from "./types";
import { readClaudeBilling, readCodexBilling, readPiBilling } from "./usage/billing";
import { claudeProjectsDirectory, readClaudeCompactSummary, readClaudeUsage } from "./usage/claude";
import { codexRolloutId, codexSessionsDirectory, readCodexUsage } from "./usage/codex";
import { ownFiles } from "./usage/files";
import { readPiCompactSummary, readPiUsage } from "./usage/pi";
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

/** The harness's own fork of a session; see `HarnessSpec.forkSession`. */
export type ForkPlan = TurnPlan & {
  /** The new session, and the running total printed with it where there is one; or why not. */
  read(stdout: string): { sessionId: string; costTotal?: number } | { error: string };
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
   * The dollars the harness printed for the turn just run, where it prints any; `readCostTotal`
   * instead where it prints the session's. Tokens are read from its session files, by
   * `readSessionUsage`.
   */
  readCharge?(stdout: string): number | undefined;
  /**
   * The dollars the harness printed for its whole session so far, where it prints a running total
   * rather than the turn's (F9). A turn charges what the total grew by.
   */
  readCostTotal?(stdout: string): number | undefined;
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
  /**
   * Its own fork of `sessionId` into a new session, `newSessionId` where it takes one, with no
   * model call (F7), so the copy is fixed when it is made. Absent where it has none.
   */
  forkSession?(sessionId: string, newSessionId: string, context: TurnContext): ForkPlan;
  /** Its own compaction in a pane: what is typed, in order, and the screen that shows it ran. */
  compactPane?: {
    prompts(focus: string): string[];
    /**
     * Whether `screen` shows a compaction after what this one's prompts put there. `before` is
     * the screen as it was before them, read only for a harness with `ended`; `""` otherwise.
     */
    compacted(screen: string, focus: string, before: string): boolean;
    /**
     * Whether `screen` shows this compaction over, compacted or not. A harness that reports itself
     * idle while it compacts, as pi does, is read until it does. Absent, the settled screen is
     * final.
     */
    ended?(screen: string, before: string): boolean;
  };
  /**
   * How to let its sandbox reach local sockets, which `awf run --here` and every `wf` call need,
   * where its default sandbox does not (E8).
   */
  localSockets?: string;
  /**
   * What its screen shows once the operator stops a turn, where that can be told apart (story 014,
   * E8's follow-up). Absent, an interrupted turn looks like one that ended without answering.
   */
  interrupted?: string;
  /**
   * The summary of a session's last compaction, from the harness's own record, where it keeps one.
   * `session` is the session as the pane's harness names it: an id, or for pi its file's path.
   */
  readCompactSummary?(session: string, cwd: string): Promise<string | undefined>;
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
    interrupted: "Interrupted · What should Claude do instead?",
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
    readCostTotal: (stdout) => reported(lastJson(stdout)?.total_cost_usd),
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
    // `/cost` is a local command: the fork is written and its cost printed, and nothing is sent.
    // A turn means the model was asked after all, and the copy holds more than it was given.
    forkSession: (sessionId, newSessionId, { model, launchArgs = [] }) => ({
      argv: [
        "claude",
        "-p",
        "--resume",
        sessionId,
        "--fork-session",
        "--session-id",
        newSessionId,
        ...launchArgs,
        "--output-format",
        "json",
        ...(model ? ["--model", model] : []),
      ],
      stdin: "/cost",
      sessionId: newSessionId,
      read: (stdout) => {
        const row = lastJson(stdout);
        const forked = text(row?.session_id);
        if (!forked || forked === sessionId) {
          return { error: `claude wrote no fork${row ? "" : `: ${stdout.trim().slice(0, 300)}`}` };
        }
        if (count(row?.num_turns) > 0) return { error: "claude asked the model while forking" };
        const costTotal = reported(row?.total_cost_usd);
        return { sessionId: forked, ...(costTotal === undefined ? {} : { costTotal }) };
      },
    }),
    compactPane: {
      prompts: (focus) => [`/compact ${focus}`],
      // The whole line, which an echoed focus would not hold.
      compacted: (screen) =>
        after(screen, "/compact").includes("Compacted (ctrl+o to see full summary)"),
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
    interrupted: "Conversation interrupted",
    localSockets:
      "codex's workspace-write sandbox blocks local sockets: start codex with -c sandbox_workspace_write.network_access=true, or approve running awf outside its sandbox",
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
        .flatMap((name) => codexRolloutId(name) ?? []),
    // A ChatGPT login pays for OpenAI's models only; another provider bills on its own terms.
    billing: ({ provider, run }) =>
      provider && provider !== "openai" ? Promise.resolve("unknown") : readCodexBilling(run),
  },

  pi: {
    sessionEnv: "PI_SESSION_ID",
    interrupted: "Operation aborted",
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
    // pi ends a "turn" after each request, so a prompt's charge is every one of them.
    readCharge: (stdout) => {
      const costs = jsonLines(stdout)
        .filter((row) => row.type === "turn_end")
        .flatMap((row) => reported(record(record(record(row.message)?.usage)?.cost)?.total) ?? []);
      return costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0);
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
    // pi echoes no slash command. A compaction clears its chat and redraws one `Compacted from N
    // tokens` line, so a new one is that line changed; pi refuses to compact twice in a row, so N
    // never repeats. A failure or a cancel prints an error instead, and Herdr sees pi idle while
    // it compacts, so the screen is read until one of them shows. The line read before a new
    // line is typed: pi's `/compact` takes the rest of its line as the focus.
    compactPane: {
      prompts: (focus) => [`/compact ${focus.replace(/\s+/g, " ").trim()}`],
      compacted: (screen, _focus, before) => piCompacted(screen, before),
      ended: (screen, before) => piCompacted(screen, before) || piRefused(screen, before),
    },
    readCompactSummary: (session) => readPiCompactSummary(session),
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
const PI_COMPACTED = /Compacted from [\d,]+ tokens/;
const PI_REFUSED = /Error: Compaction (failed|cancelled)/;

function lastMatch(screen: string, pattern: RegExp): string | undefined {
  return screen.split("\n").findLast((line) => pattern.test(line));
}

function piCompacted(screen: string, before: string): boolean {
  const now = lastMatch(screen, PI_COMPACTED);
  return now !== undefined && now !== lastMatch(before, PI_COMPACTED);
}

/**
 * A refusal is not redrawn away, so a new one adds a line. Or it is the screen's last word where
 * it was not before, should the count lose a line off the top of the window.
 */
function piRefused(screen: string, before: string): boolean {
  const refusals = (text: string) => text.split("\n").filter((line) => PI_REFUSED.test(line));
  const lastEvent = (text: string) =>
    text.split("\n").findLast((line) => PI_REFUSED.test(line) || PI_COMPACTED.test(line));
  const last = lastEvent(screen);
  return (
    refusals(screen).length > refusals(before).length ||
    (last !== undefined && PI_REFUSED.test(last) && last !== lastEvent(before))
  );
}

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
 * The harnesses each placement's run host runs. A pane is claude, codex or pi: claude's and
 * codex's startup screens are driven, and pi shows none (story 017). Cursor's are not yet. A
 * headless turn is any harness in the table.
 */
export const PLACEMENT_HARNESSES = {
  pane: ["claude", "codex", "pi"],
  headless: HARNESS_NAMES,
} as const satisfies Record<AgentPlacement, readonly [Harness, ...Harness[]]>;

export function knownHarness(value: string): Harness {
  if (findHarness(value)) return value as Harness;
  throw new Error(`unsupported harness: ${value}`);
}
