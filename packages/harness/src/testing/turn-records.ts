import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
/**
 * Records a turn prompted with `text` as claude and codex would, in each one's home: its prompt,
 * an answer, and, unless `open`, its end. Only a prompt carrying a delivery marker is read for it.
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
  const project = join(
    options.claude ?? isolated("CLAUDE_CONFIG_DIR"),
    "projects",
    (options.cwd ?? "/repo").replace(/[^A-Za-z0-9]/g, "-"),
  );
  mkdirSync(project, { recursive: true });
  const claude = [
    { type: "user", uuid: `u${n}`, message: { content: text } },
    {
      type: "assistant",
      uuid: `a${n}`,
      parentUuid: `u${n}`,
      message: { role: "assistant", model: "claude-test" },
    },
    ...(options.open
      ? []
      : [
          options.interrupted
            ? { type: "user", uuid: `i${n}`, message: { content: "[Request interrupted by user]" } }
            : { type: "system", subtype: "turn_duration", uuid: `d${n}` },
        ]),
  ];
  appendFileSync(
    join(project, `${session}.jsonl`),
    claude.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = join(
    options.codex ?? isolated("CODEX_HOME"),
    "sessions",
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
  mkdirSync(day, { recursive: true });
  const codex = [
    { type: "event_msg", payload: { type: "user_message", message: text, turn_id: `t${n}` } },
    { type: "response_item", payload: { type: "message", role: "assistant" } },
    ...(options.open
      ? []
      : [
          {
            type: "event_msg",
            payload: {
              type: options.interrupted ? "turn_aborted" : "task_complete",
              turn_id: `t${n}`,
            },
          },
        ]),
  ];
  const rollout = join(day, `rollout-2026-01-01T00-00-00-${session}.jsonl`);
  appendFileSync(rollout, codex.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return (interrupted = false) => {
    const end = interrupted
      ? { type: "user", uuid: `i${n}`, message: { content: "[Request interrupted by user]" } }
      : { type: "system", subtype: "turn_duration", uuid: `d${n}` };
    appendFileSync(join(project, `${session}.jsonl`), `${JSON.stringify(end)}\n`);
    appendFileSync(
      rollout,
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: interrupted ? "turn_aborted" : "task_complete", turn_id: `t${n}` },
      })}\n`,
    );
  };
}
