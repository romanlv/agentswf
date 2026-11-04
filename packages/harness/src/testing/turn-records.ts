import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectName, claudeProjectsDirectory } from "../usage/claude";
import { codexSessionsDirectory } from "../usage/codex";

const HOMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/**
 * Points claude's and codex's homes at a directory of the tests' own, so the records a fake writes
 * never reach the operator's. `fresh` gives each test empty ones: an agent's name, and so the
 * session it records, recurs across tests. `restore` puts the operator's back.
 */
export function isolateHarnessHomes(prefix: string) {
  const original = Object.fromEntries(HOMES.map((name) => [name, process.env[name]]));
  const root = mkdtempSync(join(tmpdir(), prefix));
  const fresh = () => {
    for (const name of HOMES) process.env[name] = mkdtempSync(join(root, `${name}-`));
  };
  fresh();
  return {
    fresh,
    restore() {
      for (const name of HOMES) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let recordedRows = 0;

/** A home `isolateHarnessHomes` set: a fake never writes the operator's. */
function isolated(name: (typeof HOMES)[number]): string {
  const home = process.env[name];
  if (!home?.startsWith(tmpdir()))
    throw new Error(`${name} is not a test's own: call isolateHarnessHomes first`);
  return home;
}
/** claude's session file for `session` in `cwd`, under `home`, its directory made. */
function claudeFile(home: string, cwd: string, session: string): string {
  const project = join(claudeProjectsDirectory(home), claudeProjectName(cwd));
  mkdirSync(project, { recursive: true });
  return join(project, `${session}.jsonl`);
}

/** codex's rollout for `session`, under `home`, in today's directory, made. */
function codexFile(home: string, session: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = join(
    codexSessionsDirectory(home),
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
  mkdirSync(day, { recursive: true });
  return join(day, `rollout-2026-01-01T00-00-00-${session}.jsonl`);
}

const append = (file: string, rows: readonly unknown[]) =>
  appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));

/**
 * Records a turn prompted with `text` as claude and codex would, in each one's home: its prompt,
 * an answer, and, unless `open`, its end, which the function returned records later. Only a prompt
 * carrying a delivery marker is read for it.
 */
export function recordTurn(
  text: string,
  session: string,
  options: {
    open?: boolean;
    interrupted?: boolean;
    cwd?: string;
    claude?: string;
    codex?: string;
  } = {},
): (interrupted?: boolean) => void {
  const n = ++recordedRows;
  const transcript = claudeFile(
    options.claude ?? isolated("CLAUDE_CONFIG_DIR"),
    options.cwd ?? "/repo",
    session,
  );
  const rollout = codexFile(options.codex ?? isolated("CODEX_HOME"), session);
  append(transcript, [
    { type: "user", uuid: `u${n}`, message: { content: text } },
    {
      type: "assistant",
      uuid: `a${n}`,
      parentUuid: `u${n}`,
      message: { role: "assistant", model: "claude-test" },
    },
  ]);
  append(rollout, [
    { type: "event_msg", payload: { type: "user_message", message: text, turn_id: `t${n}` } },
    { type: "response_item", payload: { type: "message", role: "assistant" } },
  ]);
  const end = (interrupted = false) => {
    append(transcript, [
      interrupted
        ? { type: "user", uuid: `i${n}`, message: { content: "[Request interrupted by user]" } }
        : { type: "system", subtype: "turn_duration", uuid: `d${n}` },
    ]);
    append(rollout, [
      {
        type: "event_msg",
        payload: { type: interrupted ? "turn_aborted" : "task_complete", turn_id: `t${n}` },
      },
    ]);
  };
  if (!options.open) end(options.interrupted);
  return end;
}

/** Records a compaction of `session` as claude and codex would, in each one's home. */
export function recordCompaction(session: string, options: { cwd?: string } = {}) {
  append(claudeFile(isolated("CLAUDE_CONFIG_DIR"), options.cwd ?? "/repo", session), [
    { type: "system", subtype: "compact_boundary" },
    { type: "user", isCompactSummary: true, message: { content: "The summary." } },
  ]);
  append(codexFile(isolated("CODEX_HOME"), session), [
    { type: "event_msg", payload: { type: "task_started", turn_id: "c1" } },
    { type: "compacted", payload: { message: "" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "c1" } },
  ]);
}
