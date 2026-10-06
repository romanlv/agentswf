import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type CallerPane,
  focusTab,
  HARNESSES,
  herdrReachable,
  runProcess,
  searchCaller,
  startInNewTab,
} from "@agentswf/harness";
import { messageOf } from "./errors";
import { linkNew } from "./files";
import { runSessionName } from "./herdr-run-session";
import type { OperatorEnvironment } from "./operator-cli";
import { callerSession, herdrConfig } from "./operator-runtime";
import type { RunCommand } from "./run-command";
import { loadAndPrepare } from "./run-prepare";
import { processStart, sameProcess } from "./runs";

/** What `--here` and `--session` reach Herdr and the calling session through. */
type HereEnvironment = Pick<
  OperatorEnvironment,
  "herdr" | "environment" | "self" | "callerSearchMs" | "signal" | "now"
>;

export type Caller = { pane: CallerPane; session: string };

export const SESSION_CODE = /^awf-here-[0-9a-f]{8}$/;
const CALLER_SEARCH_MS = 120_000;

/**
 * `awf run --here`, in an agent's shell: checks the workflow loads and its run can start, and that
 * the session can be driven, then has Herdr start the run in a new tab, outside this shell and any
 * sandbox it is in, and prints the code the agent ends its turn with (ADR 0010). Nothing is started
 * when a check fails.
 */
export async function startHere(
  argv: readonly string[],
  command: RunCommand,
  environment: HereEnvironment,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  notice: (text: string) => void,
): Promise<number> {
  // In this shell, before any tab opens: a workflow that will not load or a run that will not
  // start is said here, where the agent reads it, and not in a tab nobody is looking at.
  const ready = await loadAndPrepare(command, (environment.now ?? Date.now)());
  if ("refused" in ready) {
    stderr(`awf: ${ready.refused}`);
    return 2;
  }
  for (const line of ready.prepared.continued?.warnings ?? []) notice(line);
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
  try {
    // Said in this shell: the run's own tab would find it only after taking the session over.
    runSessionName(env);
  } catch (error) {
    stderr(`awf: --here: ${messageOf(error)}`);
    return 2;
  }
  let session: string;
  try {
    session = await callerSession(run, env);
  } catch (error) {
    return refuse(`Herdr did not answer: ${messageOf(error)}`, sandboxFix(env));
  }
  const unreachable = await herdrReachable(herdrConfig(session), run);
  if (unreachable) {
    return refuse(`this session cannot reach Herdr: ${unreachable.trim()}`, sandboxFix(env));
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
      label: tabLabel(
        ready.loaded.executable.definition.meta.name,
        command.continueId ?? ready.prepared.id,
      ),
      argv: [...self, "run", "--session", code, ...options, ...rest],
      // The tab takes the Herdr server's environment, not this shell's: the operator's choice of
      // where the run's agents open is passed on.
      ...(env.AWF_HERDR_SESSION ? { env: { AWF_HERDR_SESSION: env.AWF_HERDR_SESSION } } : {}),
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
      `awf: ${basename(ready.loaded.file)} is starting in Herdr tab ${started.tabId}. Once this turn ends it takes this session over: each of its steps arrives here as a prompt, and a last message hands the session back.`,
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
    const release = await claimCaller(callers, found.caller.pane.paneId);
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
 * refused, as ADR 0010 allows one at a time. A mark whose process is gone, or is another process
 * with its pid, is taken over. The reason when refused.
 */
async function claimCaller(marks: string, paneId: string): Promise<(() => void) | string> {
  const mark = join(marks, `${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const started = processStart(process.pid);
  if (started === undefined) return `ps gave no start time for this process (${process.pid})`;
  const holder: CallerMark = { pid: process.pid, processStart: started };
  try {
    await mkdir(marks, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await linkNew(mark, holder)) return () => rmSync(mark, { force: true });
      const other = await readMark(mark);
      if (other && sameProcess(other.pid, other.processStart)) {
        return `another run (process ${other.pid}) is already driving the session in ${paneId}; one run drives a session at a time`;
      }
      await rm(mark, { force: true });
    }
    return `could not mark the session in ${paneId} as driven`;
  } catch (error) {
    return messageOf(error);
  }
}

/** The run driving a session: its process, and when that started, which tells a reused pid apart. */
type CallerMark = { pid: number; processStart: string };

/** A mark as written, or undefined for one gone or unreadable, which nothing holds. */
async function readMark(file: string): Promise<CallerMark | undefined> {
  try {
    const mark = JSON.parse(await readFile(file, "utf8"));
    return typeof mark?.pid === "number" && typeof mark.processStart === "string"
      ? mark
      : undefined;
  } catch {
    return undefined;
  }
}

/** Brings the tab this process runs in forward, where Herdr says which one that is. */
export async function showOwnTab(environment: HereEnvironment): Promise<void> {
  const env = environment.environment ?? process.env;
  if (!env.HERDR_TAB_ID) return;
  const session = await callerSession(environment.herdr ?? runProcess, env).catch(() => undefined);
  if (session) await focusTab(herdrConfig(session), env.HERDR_TAB_ID, environment.herdr);
}

/** The pane showing `code`, in the Herdr session this run's tab is in, for `--session`. */
async function findCaller(
  code: string,
  environment: HereEnvironment,
): Promise<{ kind: "found"; caller: Caller } | { kind: "refused"; reason: string }> {
  const run = environment.herdr ?? runProcess;
  let session: string;
  try {
    session = await callerSession(run, environment.environment ?? process.env);
  } catch (error) {
    return { kind: "refused", reason: messageOf(error) };
  }
  const found = await searchCaller(
    herdrConfig(session),
    code,
    {
      by: (environment.now ?? Date.now)() + (environment.callerSearchMs ?? CALLER_SEARCH_MS),
      ...(environment.signal ? { signal: environment.signal } : {}),
    },
    run,
  );
  return found.kind === "found" ? { kind: "found", caller: { pane: found.pane, session } } : found;
}

/** The run's tab, named as its Herdr workspace is, but for the attempt, which isn't claimed yet. */
function tabLabel(workflow: string, id: string | undefined): string {
  return `awf ${workflow}${id === undefined ? "" : ` ${id}`}`;
}
