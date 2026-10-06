import { dirname, join } from "node:path";
import { text } from "../json";
import { cursorAllowance } from "../usage/allowance";
import {
  cursorChatDirectory,
  cursorHomeSessions,
  cursorSessionFiles,
  dropCursorUsage,
  findCursorChat,
  keepCursorTurnUsage,
  readCursorUsage,
} from "../usage/cursor";
import {
  defineHarness,
  type HarnessDefinition,
  type LaunchSettings,
  type TurnContext,
  type TurnPlan,
} from "./define";
import { cursorLogin } from "./login";
import { lastJson, resuming } from "./shared";

/**
 * `--force` runs its tools without asking; `--trust` answers the trust screen its TUI shows even
 * so, which swallowed the prompts sent while it was up (C7).
 */
function cursorInteractive(
  { model }: LaunchSettings = {},
  launchArgs: readonly string[] = [],
): TurnPlan {
  return {
    argv: [
      "cursor-agent",
      "--force",
      "--trust",
      ...(model ? ["--model", model] : []),
      ...launchArgs,
    ],
  };
}

function cursorHeadless(
  prompt: string,
  resume: readonly string[],
  { model, launchArgs = [] }: TurnContext,
): TurnPlan {
  return {
    argv: [
      "cursor-agent",
      "-p",
      ...resume,
      "--output-format",
      "json",
      "--force",
      ...launchArgs,
      ...(model ? ["--model", model] : []),
    ],
    stdin: prompt,
  };
}

const CURSOR = {
  sessionEnv: "CURSOR_CONVERSATION_ID",
  callingSessionEnv: ["CURSOR_AGENT", "CURSOR_CONVERSATION_ID", "CURSOR_REQUEST_ID"],
  settingsEnv: [],
  meteredCredentials: [],
  // Herdr 0.9.1 names a cursor pane's chat, the id its shell's `CURSOR_CONVERSATION_ID` holds.
  herdrSessionIsOwn: true,
  meteredHeadless: false,
  // A resume runs on the `--model` it is given, a model's other variant included (M1).
  setHeadless: true,
  interactive: cursorInteractive,
  login: cursorLogin,
  // Herdr reports it idle about 3.5 s after it starts, drawn or not; under srt it drew 2.5 s later.
  // Its status line names the mode `--force` sets.
  paneReady: "Run Everything",
  interactiveResume: (sessionId, settings, launchArgs) =>
    resuming(cursorInteractive(settings, launchArgs), "--resume", sessionId),
  headlessTurn: (prompt, context) => cursorHeadless(prompt, [], context),
  resumeTurn: (prompt, sessionId, context) =>
    cursorHeadless(prompt, ["--resume", sessionId], context),
  readSessionId: (stdout) => text(lastJson(stdout)?.session_id),
  readTranscript: (stdout) => text(lastJson(stdout)?.result) ?? stdout,
  // Its CLI has no fork; its TUI's `/fork` copies the chat's store under a new id and gives it a
  // new `agentId`, which keys cursor's cache, so that fork misses it. A copy of the chat's
  // directory keeps its parent's `agentId` and reads its parent's cache, its history its own
  // (F11).
  forkSession: async (session, newSessionId, { home }) => {
    const parent = await cursorChatDirectory(session, home);
    if (!parent) throw new Error(`cursor has no chat ${session} to fork`);
    const fork = join(dirname(parent), newSessionId);
    return {
      argv: ["cp", "-R", parent, fork],
      read: () => ({ sessionId: newSessionId }),
      finish: (forked) => dropCursorUsage(forked, home),
    };
  },
  // `/summarize` takes no focus: the text after it looked ignored (C7). The focus goes in as a
  // message first, as codex's does, which the summary followed live (story 019).
  compactPane: {
    prompts: (focus) => [cursorCompactionFocus(focus), "/summarize"],
    compacted: (screen, _focus, before) => {
      const summary = lastSummary(screen);
      return summary !== undefined && summary !== lastSummary(before);
    },
    // Herdr's wait returns once the summary is drawn; this only has the screen before read.
    ended: () => true,
  },
  keepTurnUsage: (stdout, session, { model, home }) =>
    keepCursorTurnUsage(stdout, session, model, home),
  readSessionUsage: (sessions, _cwd, home) => readCursorUsage(sessions, home),
  sessionFiles: (home, session) => cursorSessionFiles(home, session),
  homeSessions: (home) => cursorHomeSessions(home),
  findSession: async (_marker, since, _cwd, home) =>
    home ? findCursorChat(since, home) : undefined,
  // Typed whole, its Enter only picks the command in the menu `/` opens; a second Enter runs it.
  allowancePane: {
    steps: [
      { type: "/usage" },
      { await: "Show plan and on-demand usage" },
      { key: "Enter" },
      // Drawn last, below every row.
      { await: "Esc to close" },
    ],
    read: cursorAllowance,
  },
} satisfies HarnessDefinition;

const TRANSCRIPT_LOCATION = "Transcript location:";

/**
 * The summary box's last lines above the transcript's path, which it ends every summary with. The
 * focus and every prompt are quoted inside the box, so no text of ours marks where it starts.
 */
function lastSummary(screen: string): string | undefined {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((line) => line.includes(TRANSCRIPT_LOCATION));
  return at < 0 ? undefined : lines.slice(Math.max(0, at - 12), at).join("\n");
}

function cursorCompactionFocus(focus: string): string {
  return `Your context is about to be compacted. For its summary: ${focus}\n\nReply only: ok`;
}

export const cursor = defineHarness(CURSOR, {
  readCharge: "cursor prints no dollars, which E1 also found",
  readCostTotal: "cursor prints no dollars, which E1 also found",
  billing:
    "nothing cursor reports tells usage within its plan from on-demand usage, which is billed per token",
  compactHeadless: "cursor compacts only in its TUI; headless, `/summarize` goes to the model (C7)",
  localSockets: "only codex's own sandbox was found blocking local sockets (E8)",
  interrupted:
    "cursor draws no line of its own for an interrupted turn: a stopped tool's line ends in `Cancelled`, and a stopped reply puts the prompt back in the input (2026.10.01)",
  readCompactSummary: "cursor draws its summary on the screen only; its transcript keeps none (C7)",
  effort:
    "cursor names a model's effort in its id, as `gpt-5.6-luna-high`, or as a parameter whose key differs per model; a variant is chosen as the model (M3)",
  readAllowance:
    "only its TUI shows the plan: headless, `-p /usage` and `cursor-agent usage` go to the model as a prompt (2026.10.01)",
  setPane:
    "not measured: a cursor pane rewrites the operator's `~/.cursor/cli-config.json`, and one in a home of its own asks for the macOS keychain (M2)",
});
