import { createHash } from "node:crypto";
import { mkdir, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HERDR_VERSION, type RunProcess } from "@agentswf/harness";
import { messageOf } from "./errors";
import { ensureRunSession, parseSessions, type RunSessionDeps } from "./herdr-run-session";
import { machinePaths } from "./machine";

/** Where a layout may open a session awf does not otherwise use: one named `awf-…` it starts. */
const OWN_SESSION = /^awf(-|$)/;
const LOCK_POLL_MS = 100;
/** Held inside a session's queue: a short wait, then made anyway. */
const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a run that died holding it. */
const LOCK_STALE_MS = 30_000;

/**
 * Whether a session a layout names can be used: undefined when it can, else why not. One named
 * `awf-…` is started, swept and restarted as the run session is; any other must be running. Either
 * must answer, on the Herdr the adapter drives.
 */
export async function namedSession(
  name: string,
  deps: RunSessionDeps,
): Promise<string | undefined> {
  if (OWN_SESSION.test(name)) {
    try {
      await ensureRunSession(name, deps);
    } catch (error) {
      return messageOf(error);
    }
  } else {
    const listed = await deps.run({
      argv: ["herdr", "session", "list", "--json"],
      timeoutMs: 10_000,
    });
    const found = parseSessions(listed.stdout).find((session) => session.name === name);
    if (!found?.running) {
      return "it is not running, and awf starts only sessions named awf-…";
    }
  }
  return wrongVersion(name, deps.run);
}

/** Why the session's server is not the Herdr the adapter drives; undefined when it is. */
async function wrongVersion(session: string, run: RunProcess): Promise<string | undefined> {
  const status = await run({
    argv: ["herdr", "--session", session, "status", "server", "--json"],
    timeoutMs: 10_000,
  });
  if (status.exitCode !== 0) return "it does not answer";
  let version: unknown;
  try {
    version = JSON.parse(status.stdout).version;
  } catch {
    return "its status could not be read";
  }
  const driven = HERDR_VERSION.replace(/^herdr /, "");
  return version === driven ? undefined : `it runs Herdr ${String(version)}, not ${driven}`;
}

export type OriginDeps = {
  run: RunProcess;
  environment: Readonly<Record<string, string | undefined>>;
  /** The run session, which `"origin"` must not be. */
  runSession: string;
  /** The calling session's pane under `--here`, found before the workflow started. */
  callerPane?: string;
  /** This process, whose ancestors include the shell `awf run` was typed in. */
  pid?: number;
};

/**
 * The workspace `awf run` was typed in, and its session; why not, where it can't be used. Read
 * from Herdr, never from `HERDR_WORKSPACE_ID`, which a codex shell inherits from its daemon (E8).
 */
export async function findOrigin(
  deps: OriginDeps,
): Promise<{ session: string; workspaceId: string } | string> {
  const { run, environment } = deps;
  const socket = environment.HERDR_SOCKET_PATH;
  if (!socket) return "awf run was not started in a Herdr pane";
  const listed = await run({ argv: ["herdr", "session", "list", "--json"], timeoutMs: 10_000 });
  const session = parseSessions(listed.stdout).find((found) => found.socketPath === socket)?.name;
  if (!session) return `no Herdr session owns ${socket}`;
  if (session === deps.runSession) {
    return `it is the run session, ${session}, whose workspaces are runs'`;
  }
  const herdr = (args: string[]) =>
    run({ argv: ["herdr", "--session", session, ...args], timeoutMs: 10_000 });
  const stale = await wrongVersion(session, run);
  if (stale) return `its session ${session}: ${stale}`;
  let paneId = deps.callerPane;
  if (!paneId) {
    paneId = environment.HERDR_PANE_ID;
    if (!paneId) return "HERDR_PANE_ID is not set";
    // A codex shell inherits its daemon's HERDR_PANE_ID, which names another pane (E8).
    const info = await herdr(["pane", "process-info", "--pane", paneId]);
    const shell = info.exitCode === 0 ? readShell(info.stdout) : undefined;
    if (shell === undefined) return `pane ${paneId} could not be read`;
    if (!(await ancestors(run, deps.pid ?? process.pid)).includes(shell)) {
      return `HERDR_PANE_ID names pane ${paneId}, which awf run was not typed in`;
    }
  }
  const got = await herdr(["pane", "get", paneId]);
  let workspaceId: unknown;
  try {
    workspaceId = JSON.parse(got.stdout).result?.pane?.workspace_id;
  } catch {}
  if (got.exitCode !== 0 || typeof workspaceId !== "string") {
    return `pane ${paneId}'s workspace could not be read`;
  }
  return { session, workspaceId };
}

function readShell(stdout: string): number | undefined {
  try {
    const shell = JSON.parse(stdout).result?.process_info?.shell_pid;
    return typeof shell === "number" ? shell : undefined;
  } catch {
    return undefined;
  }
}

/** `pid`'s parent, its parent's, and so on, as `ps` gives them. */
async function ancestors(run: RunProcess, pid: number): Promise<number[]> {
  const found: number[] = [];
  for (let current = pid; current > 1 && found.length < 64; ) {
    const parent = await run({
      argv: ["ps", "-o", "ppid=", "-p", String(current)],
      timeoutMs: 5_000,
    });
    const next = Number(parent.stdout.trim());
    if (parent.exitCode !== 0 || !Number.isInteger(next) || next <= 0) break;
    found.push(next);
    current = next;
  }
  return found;
}

/**
 * Holds `name` in `session` against other runs while its workspace is looked for and made, so two
 * runs make one. A directory, made or not in one step; one left by a run that died expires.
 */
export function workspaceLock(home: string) {
  return async (session: string, name: string): Promise<() => Promise<void>> => {
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const dir = join(machinePaths(home).herdr, "locks", session);
    const lock = join(dir, digest);
    await mkdir(dir, { recursive: true });
    const by = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lock);
        return () => rmdir(lock).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const made = await stat(lock).then(
        (found) => found.mtimeMs,
        () => undefined,
      );
      if (made !== undefined && Date.now() - made > LOCK_STALE_MS) {
        // Moved aside first: of two waiters that saw it stale, only one moves it, and neither
        // removes a lock the other has just taken.
        const aside = `${lock}.${process.pid}.${Date.now()}`;
        if (
          await rename(lock, aside).then(
            () => true,
            () => false,
          )
        ) {
          await rmdir(aside).catch(() => undefined);
        }
        continue;
      }
      // Taking it anyway makes at worst a second workspace of the name, which is still usable.
      if (Date.now() >= by) return async () => undefined;
      await Bun.sleep(LOCK_POLL_MS);
    }
  };
}
