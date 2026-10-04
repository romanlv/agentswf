import { basename } from "node:path";
import { jsonLines, parseRow, type Row, record, text } from "../json";
import { harnessState } from "../state";
import { readCodexBilling } from "../usage/billing";
import {
  codexRolloutId,
  codexSessionFiles,
  codexSessionsDirectory,
  findCodexSession,
  inheritCodexSessionId,
  readCodexUsage,
} from "../usage/codex";
import { ownFiles } from "../usage/files";
import { defineHarness, type HarnessDefinition, type TurnPlan } from "./define";
import { after, resuming } from "./shared";

function codexInteractive(model?: string, launchArgs: readonly string[] = []): TurnPlan {
  return {
    argv: [
      "codex",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      ...(model ? ["--model", model] : []),
      ...launchArgs,
    ],
  };
}

const CODEX = {
  callingSessionEnv: ["CODEX_SESSION_ID"],
  meteredCredentials: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"],
  herdrSessionIsOwn: false,
  pastesQuoted: false,
  meteredHeadless: false,
  sessionEnv: "CODEX_SESSION_ID",
  interrupted: "Conversation interrupted",
  localSockets:
    "codex's workspace-write sandbox blocks local sockets: start codex with -c sandbox_workspace_write.network_access=true, or approve running awf outside its sandbox",
  interactive: codexInteractive,
  interactiveResume: (sessionId, model, launchArgs) =>
    resuming(codexInteractive(model, launchArgs), "resume", sessionId),
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
  // The app-server forks a thread with no turn, and exits once its stdin closes. The fork takes
  // its own id, which the response names, and is then given its parent's session id, which keys
  // the cache, so it reads its parent's (F4, F5).
  forkSession: (sessionId, _newSessionId, { model, launchArgs = [], home }) => {
    const answered = (row: Row | undefined) => row?.id === 2;
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
      stdin: `${[
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "awf", version: "0" } },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "initialized" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "thread/fork",
          params: { threadId: sessionId, excludeTurns: true, ...(model ? { model } : {}) },
        }),
      ].join("\n")}\n`,
      holdStdinUntil: (line) => answered(parseRow(line)),
      read: (stdout) => {
        const response = jsonLines(stdout).find(answered);
        const forked = text(record(record(response?.result)?.thread)?.id);
        if (forked && forked !== sessionId) return { sessionId: forked };
        const why = text(record(response?.error)?.message);
        return { error: `codex wrote no fork${why ? `: ${why}` : ""}` };
      },
      finish: (forked) => inheritCodexSessionId(home ?? harnessState().codex, sessionId, forked),
    };
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
  sessionFiles: (home, session) => codexSessionFiles(home, session),
  findSession: (marker, since, cwd, home) =>
    findCodexSession(marker, since, cwd, codexSessionsDirectory(home)),
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
} satisfies HarnessDefinition;

export const codex = defineHarness(CODEX, {
  keepTurnUsage: "codex logs each request in its rollouts",
  readCharge: "codex prints no dollars; its tokens are priced from its rollouts",
  readCostTotal: "codex prints no dollars; its tokens are priced from its rollouts",
  readCompactSummary: "codex keeps its compaction's summary opaque",
});

const CODEX_FOCUS_END = "Reply only: ok";

/** Codex compacts with no focus of its own, so it reads one as the message just before. */
function codexCompactionFocus(focus: string): string {
  return `Your context is about to be compacted. For its summary: ${focus}\n\n${CODEX_FOCUS_END}`;
}
