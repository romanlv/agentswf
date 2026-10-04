import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type CallerPane,
  focusTab,
  HARNESSES,
  herdrReachable,
  type RunProcess,
  runProcess,
  searchCaller,
  startInNewTab,
} from "@agentswf/harness";
import { messageOf } from "./errors";
import { herdrConfig, herdrSession } from "./operator-runtime";
import type { RunCommand } from "./run-command";
import { prepareRun } from "./run-continue";
import { loadWorkflowFile } from "./workflow-loader";

/** What `--here` and `--session` reach Herdr and the calling session through. */
export type HereEnvironment = {
  /** Runs `herdr` for `--here` and `--session`. */
  herdr?: RunProcess;
  environment?: Readonly<Record<string, string | undefined>>;
  /** The command that runs this awf, which `--here` types into the run's tab. */
  self?: readonly string[];
  /** How long `--session` looks for the pane showing its code. */
  callerSearchMs?: number;
  signal?: AbortSignal;
  now?: () => number;
};

export type Caller = { pane: CallerPane; session: string };

export const SESSION_CODE = /^awf-here-[0-9a-f]{8}$/;
const CALLER_SEARCH_MS = 120_000;

/**
 * `awf run --here`, in an agent's shell: checks the session can be driven, then has Herdr start the
 * run in a new tab, outside this shell and any sandbox it is in, and prints the code the agent ends
 * its turn with (ADR 0010). Nothing is started when a check fails.
 */
export async function startHere(
  argv: readonly string[],
  command: RunCommand,
  environment: HereEnvironment,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const env = environment.environment ?? process.env;
  const run = environment.herdr ?? runProcess;
  const refuse = (why: string, instead: string) => {
    stderr(`awf: --here: ${why}. ${instead}`);
    return 1;
  };
  const workspace = env.HERDR_WORKSPACE_ID;
  if (env.HERDR_ENV !== "1" || !workspace) {
    return refuse(
      "this session is not in a Herdr pane, so a run cannot drive it",
      "Start the agent in a Herdr pane, or run the workflow from a shell with awf run and no --here.",
    );
  }
  const file = resolve(command.shellCwd, command.workflowFile);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return refuse(`no workflow file at ${file}`, "Name it by a path from this directory.");
  }
  let session: string;
  try {
    session = await herdrSession(run, env);
  } catch (error) {
    return refuse(`Herdr did not answer: ${messageOf(error)}`, sandboxFix(env));
  }
  const unreachable = await herdrReachable(herdrConfig(session), run);
  if (unreachable) {
    return refuse(`this session cannot reach Herdr: ${unreachable.trim()}`, sandboxFix(env));
  }
  // In this shell, before any tab opens: a workflow that will not load fails here, where the agent
  // reads it, and not in a tab nobody is looking at.
  try {
    const loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
    await prepareRun(command, loaded, (environment.now ?? Date.now)());
  } catch (error) {
    return refuse(`the workflow cannot start: ${messageOf(error)}`, "Fix it, then run this again.");
  }
  const code = `awf-here-${randomBytes(4).toString("hex")}`;
  const end = argv.indexOf("--");
  const options = (end === -1 ? argv.slice(1) : argv.slice(1, end)).filter(
    (arg) => arg !== "--here",
  );
  const rest = end === -1 ? [] : argv.slice(end);
  const self = environment.self ?? [process.execPath, "--no-env-file", process.argv[1]!];
  const started = await startInNewTab(
    herdrConfig(session),
    {
      // Under codex this can be another pane's workspace (E8); the run's tab still works from it.
      workspace,
      cwd: command.shellCwd,
      label: `awf ${basename(file)}${command.continueId === undefined ? "" : ` ${command.continueId}`}`,
      argv: [...self, "run", "--session", code, ...options, ...rest],
    },
    run,
  );
  if (!started.ok) {
    return refuse(
      `Herdr did not open the run's tab: ${started.error}`,
      "Run the workflow from a shell with awf run instead.",
    );
  }
  stdout(
    [
      `awf: ${basename(file)} is starting in Herdr tab ${started.tabId}. Once this turn ends it takes this session over: each of its steps arrives here as a prompt, and a last message hands the session back.`,
      "",
      "End your turn now by replying with only this line, exactly:",
      code,
    ].join("\n"),
  );
  return 0;
}

/**
 * `awf run --session`: the session showing `code`, marked as driven by this process until the
 * release, under `callers`. The reason when it can't be had, said in this run's own tab too.
 */
export async function takeCaller(
  code: string,
  callers: string,
  environment: HereEnvironment,
): Promise<{ caller: Caller; release: () => void } | string> {
  const found = await findCaller(code, environment);
  let refused: string;
  if (found.kind === "found") {
    const release = claimCaller(callers, found.caller.pane.paneId);
    if (typeof release !== "string") return { caller: found.caller, release };
    refused = release;
  } else {
    refused = found.reason;
  }
  // The session that started this waits on a run that will not come, and this tab opened
  // unfocused: it is the one place that says why.
  await showOwnTab(environment);
  return refused;
}

/**
 * What lets a sandboxed session reach Herdr's socket, which `--here` and every `wf` call need: its
 * harness's own advice, for the harness whose session variable this shell has.
 */
function sandboxFix(env: Readonly<Record<string, string | undefined>>): string {
  const harness = Object.values(HARNESSES).find(
    (spec) => spec.sessionEnv && env[spec.sessionEnv] && spec.localSockets,
  );
  return harness?.localSockets
    ? `${harness.localSockets}.`
    : "If this session runs in a sandbox, let it reach Herdr's socket and local sockets, or run the workflow from a shell with awf run.";
}

/**
 * Marks `paneId` as driven by this process until the returned release, under `~/.awf`, which every
 * run on this machine shares whatever its run root: a second run started from a driven session is
 * refused, as ADR 0010 allows one at a time. A mark whose process is gone is taken over. The
 * reason when refused.
 */
function claimCaller(marks: string, paneId: string): (() => void) | string {
  const mark = join(marks, `${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}.pid`);
  mkdirSync(marks, { recursive: true });
  // Linked into place whole, so a run reading the mark never sees it without its pid.
  const pending = `${mark}.${process.pid}`;
  try {
    writeFileSync(pending, String(process.pid));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(pending, mark);
        return () => rmSync(mark, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return messageOf(error);
        const holder = Number(readFileSync(mark, "utf8"));
        if (alive(holder)) {
          return `another run (process ${holder}) is already driving the session in ${paneId}; one run drives a session at a time`;
        }
        rmSync(mark, { force: true });
      }
    }
    return `could not mark the session in ${paneId} as driven`;
  } catch (error) {
    return messageOf(error);
  } finally {
    rmSync(pending, { force: true });
  }
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Brings the tab this process runs in forward, where Herdr says which one that is. */
async function showOwnTab(environment: HereEnvironment): Promise<void> {
  const env = environment.environment ?? process.env;
  if (!env.HERDR_TAB_ID) return;
  const session = await herdrSession(environment.herdr ?? runProcess, env).catch(() => undefined);
  if (session) await focusTab(herdrConfig(session), env.HERDR_TAB_ID, environment.herdr);
}

/** The pane showing `code`, in the Herdr session awf runs in, for `--session`. */
async function findCaller(
  code: string,
  environment: HereEnvironment,
): Promise<{ kind: "found"; caller: Caller } | { kind: "refused"; reason: string }> {
  const run = environment.herdr ?? runProcess;
  let session: string;
  try {
    session = await herdrSession(run, environment.environment ?? process.env);
  } catch (error) {
    return { kind: "refused", reason: messageOf(error) };
  }
  const found = await searchCaller(
    herdrConfig(session),
    code,
    {
      by: Date.now() + (environment.callerSearchMs ?? CALLER_SEARCH_MS),
      ...(environment.signal ? { signal: environment.signal } : {}),
    },
    run,
  );
  return found.kind === "found" ? { kind: "found", caller: { pane: found.pane, session } } : found;
}
