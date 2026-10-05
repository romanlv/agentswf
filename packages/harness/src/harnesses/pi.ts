import { isAbsolute, join } from "node:path";
import { jsonLines, parseRow, type Row, record, reported, text } from "../json";
import { readPiBilling } from "../usage/billing";
import { ownFiles } from "../usage/files";
import {
  piForksDirectory,
  piSessionFile,
  piSessionFiles,
  readPiCompactSummary,
  readPiUsage,
} from "../usage/pi";
import { defineHarness, type HarnessDefinition, type LaunchSettings } from "./define";

const PI = {
  callingSessionEnv: ["PI_SESSION_ID"],
  settingsEnv: [],
  // pi logs in to the providers claude and codex do, and reads the same keys.
  meteredCredentials: [],
  herdrSessionIsOwn: true,
  meteredHeadless: false,
  effort: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  setHeadless: true,
  setPane: true,
  sessionEnv: "PI_SESSION_ID",
  interrupted: "Operation aborted",
  interactive: (settings = {}, launchArgs = []) => ({
    argv: ["pi", ...piSettings(settings), ...launchArgs],
  }),
  interactiveResume: (session, settings = {}, launchArgs = []) => ({
    argv: ["pi", ...piSession(session), ...piSettings(settings), ...launchArgs],
  }),
  // pi is the one harness whose session id we choose: `--session-id` creates it on the first
  // turn and reuses it on the second, so no id has to be scraped back out of the output.
  headlessTurn: (prompt, { sessionHint, launchArgs = [], ...settings }) => ({
    argv: [
      "pi",
      "--print",
      "--mode",
      "json",
      "--session-id",
      sessionHint,
      ...launchArgs,
      ...piSettings(settings),
    ],
    stdin: prompt,
    sessionId: sessionHint,
  }),
  // A fork's session is its file's path: its id is its parent's (F6), which names the parent.
  resumeTurn: (prompt, session, { launchArgs = [], ...settings }) => ({
    argv: [
      "pi",
      "--print",
      "--mode",
      "json",
      ...piSession(session),
      ...launchArgs,
      ...piSettings(settings),
    ],
    stdin: prompt,
    sessionId: session,
  }),
  // A turnless rpc fork into a directory of its own two levels below the sessions root, keeping
  // its parent's id, which is its provider's cache key (F6, F7). pi's lookup by id never reaches
  // it there, so it is named by its file.
  forkSession: async (session, newSessionId, { model, launchArgs = [], home }) => {
    const parent = await piSessionFile(session, home);
    if (!parent) throw new Error(`pi has no session ${session} to fork`);
    const answered = (row: Row | undefined) =>
      row?.type === "response" && row.command === "get_state";
    return {
      argv: [
        "pi",
        "--mode",
        "rpc",
        "--fork",
        parent.file,
        "--session-dir",
        join(piForksDirectory(home), newSessionId),
        "--session-id",
        parent.id,
        ...launchArgs,
        ...(model ? ["--model", model] : []),
      ],
      stdin: `${JSON.stringify({ type: "get_state" })}\n`,
      holdStdinUntil: (line) => answered(parseRow(line)),
      read: (stdout) => {
        const response = jsonLines(stdout).find(answered);
        const file = text(record(response?.data)?.sessionFile);
        if (response?.success === true && file && file !== parent.file) {
          return { sessionId: file };
        }
        return { error: `pi wrote no fork: ${text(response?.error) ?? "no answer"}` };
      },
    };
  },
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
  compactHeadless: (focus, sessionId, { launchArgs = [], ...settings }) => {
    const answer = (row: Row | undefined) => row?.type === "response" && row.command === "compact";
    return {
      argv: [
        "pi",
        "--mode",
        "rpc",
        ...piSession(sessionId),
        ...launchArgs,
        ...piSettings(settings),
      ],
      sessionId,
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
  sessionFiles: (home, session) => piSessionFiles(home, session),
  homeSessions: async (home) => {
    const root = join(home, "sessions");
    return (await ownFiles(home, root))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(root, name));
  },
  // pi's provider falls back to the model's prefix, and a calling session's model is the
  // operator's, which awf never learns (ADR 0010).
  billing: ({ model, provider, caller }) =>
    caller && !provider ? Promise.resolve("unknown") : readPiBilling(model, provider),
} satisfies HarnessDefinition;

export const pi = defineHarness(PI, {
  paneReady: "Herdr's idle has followed its screen, in a sandbox too",
  keepTurnUsage: "pi logs each request in its session files",
  readCostTotal: "pi prints each request's cost, which readCharge reads",
  findSession: "Herdr names a pi pane's session by its file (story 017)",
  localSockets: "only codex's own sandbox was found blocking local sockets (E8)",
});

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

/** pi names a session by its id, or by its file where the id is a fork's parent's. */
function piSession(session: string): string[] {
  return isAbsolute(session) ? ["--session", session] : ["--session-id", session];
}

/**
 * `--thinking` beats a `:level` model suffix and the settings; a resume without it takes the
 * session's first logged level (M1, M4).
 */
function piSettings({ model, effort }: LaunchSettings): string[] {
  return [...(model ? ["--model", model] : []), ...(effort ? ["--thinking", effort] : [])];
}
