import { basename } from "node:path";
import { count, jsonLines, record, reported, text } from "../json";
import { readClaudeBilling } from "../usage/billing";
import {
  claudeProjectsDirectory,
  claudeSessionFiles,
  findClaudeSession,
  readClaudeCompactSummary,
  readClaudeUsage,
} from "../usage/claude";
import { ownFiles } from "../usage/files";
import { defineHarness, type HarnessDefinition, type TurnPlan } from "./define";
import { after, lastJson, resuming } from "./shared";

/** `Bash` has to be allowed or the agent cannot run `wf` at all. */
function claudeInteractive(model?: string, launchArgs: readonly string[] = []): TurnPlan {
  return {
    argv: [
      "claude",
      "--allowed-tools",
      "Bash",
      ...(model ? ["--model", model] : []),
      ...launchArgs,
    ],
  };
}

const CLAUDE = {
  // What a Claude Code session sets for the commands it runs. The findings tie inherited
  // `CLAUDE_*` to a pane claude saving no transcript, and the messaging token would let an agent
  // message the operator's session.
  callingSessionEnv: [
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
  ],
  meteredCredentials: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  herdrSessionIsOwn: true,
  sessionEnv: "CLAUDE_CODE_SESSION_ID",
  interrupted: "Interrupted · What should Claude do instead?",
  // `Bash` has to be allowed or the agent cannot run `wf` at all, which would measure the
  // permission prompt rather than the return channel.
  interactive: claudeInteractive,
  interactiveResume: (sessionId, model, launchArgs) =>
    resuming(claudeInteractive(model, launchArgs), "--resume", sessionId),
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
  pastesQuoted: true,
  compactPane: {
    prompts: (focus) => [`/compact ${focus}`],
    // The whole line, which an echoed focus would not hold.
    compacted: (screen) =>
      after(screen, "/compact").includes("Compacted (ctrl+o to see full summary)"),
  },
  readCompactSummary: (sessionId, cwd) => readClaudeCompactSummary(sessionId, cwd),
  readSessionUsage: (sessions, cwd, home) =>
    readClaudeUsage(sessions, cwd, claudeProjectsDirectory(home)),
  sessionFiles: (home, session, cwd) => claudeSessionFiles(home, session, cwd),
  findSession: (marker, since, cwd, home) => findClaudeSession(marker, since, cwd, home),
  homeSessions: async (home) =>
    (await ownFiles(home, claudeProjectsDirectory(home)))
      .filter((name) => /^[^/]+\/[^/]+\.jsonl$/.test(name))
      .map((name) => basename(name, ".jsonl")),
  // E3: `claude -p` bills metered on a subscription login, with no key in the environment.
  meteredHeadless: true,
  billing: ({ run }) => readClaudeBilling(run),
} satisfies HarnessDefinition;

export const claude = defineHarness(CLAUDE, {
  paneReady: "Herdr's idle has followed its screen, in a sandbox too",
  keepTurnUsage: "claude logs each request in its session files",
  readCharge: "claude prints its session's running total, which readCostTotal reads (F9)",
  localSockets: "only codex's own sandbox was found blocking local sockets (E8)",
});
