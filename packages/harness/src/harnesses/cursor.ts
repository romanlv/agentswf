import { dirname, join } from "node:path";
import { text } from "../json";
import { cursorChatDirectory } from "../usage/cursor";
import { defineHarness, type HarnessDefinition } from "./define";
import { lastJson } from "./shared";

const CURSOR = {
  callingSessionEnv: [],
  meteredCredentials: [],
  herdrSessionIsOwn: false,
  pastesQuoted: false,
  meteredHeadless: false,
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
    };
  },
} satisfies HarnessDefinition;

export const cursor = defineHarness(CURSOR, {
  sessionEnv: "not yet given",
  interactiveResume: "cursor runs headless only",
  readCharge: "cursor prints no dollars, which E1 also found",
  readCostTotal: "cursor prints no dollars, which E1 also found",
  readSessionUsage: "not yet read",
  sessionFiles: "not yet given",
  findSession: "cursor runs headless only",
  homeSessions: "not yet given",
  billing: "not yet read",
  compactHeadless: "cursor compacts only in its TUI, and runs headless only",
  compactPane: "cursor runs headless only",
  localSockets: "only codex's own sandbox was found blocking local sockets (E8)",
  interrupted: "not yet read",
  readCompactSummary: "cursor's transcript keeps no summary (C7)",
});
