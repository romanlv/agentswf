import { dirname, join } from "node:path";
import { text } from "../json";
import {
  cursorChatDirectory,
  cursorHomeSessions,
  cursorSessionFiles,
  dropCursorUsage,
  keepCursorTurnUsage,
  readCursorUsage,
} from "../usage/cursor";
import { defineHarness, type HarnessDefinition, type TurnContext, type TurnPlan } from "./define";
import { lastJson } from "./shared";

/** `--force` runs its tools without asking, and also trusts the directory, which headless asks. */
function cursorInteractive(model?: string, launchArgs: readonly string[] = []): TurnPlan {
  return { argv: ["cursor-agent", "--force", ...(model ? ["--model", model] : []), ...launchArgs] };
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
  meteredCredentials: [],
  herdrSessionIsOwn: false,
  pastesQuoted: false,
  meteredHeadless: false,
  interactive: cursorInteractive,
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
  keepTurnUsage: (stdout, session, { model, home }) =>
    keepCursorTurnUsage(stdout, session, model, home),
  readSessionUsage: (sessions, _cwd, home) => readCursorUsage(sessions, home),
  sessionFiles: (home, session) => cursorSessionFiles(home, session),
  homeSessions: (home) => cursorHomeSessions(home),
} satisfies HarnessDefinition;

export const cursor = defineHarness(CURSOR, {
  interactiveResume: "cursor runs headless only",
  readCharge: "cursor prints no dollars, which E1 also found",
  readCostTotal: "cursor prints no dollars, which E1 also found",
  findSession: "cursor runs headless only",
  billing:
    "nothing cursor reports tells usage within its plan from on-demand usage, which is billed per token",
  compactHeadless: "cursor compacts only in its TUI, and runs headless only",
  compactPane: "cursor runs headless only",
  localSockets: "only codex's own sandbox was found blocking local sockets (E8)",
  interrupted: "not yet read",
  readCompactSummary: "cursor's transcript keeps no summary (C7)",
});
