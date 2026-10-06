import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunProcess } from "@agentswf/harness";
import { messageOf } from "./errors";
import {
  liveness,
  type MarkedPane,
  readAllMarks,
  readMarks,
  removeMark,
  rewriteMark,
  type WorkspaceMark,
} from "./herdr-workspace-marks";
import { machinePaths } from "./machine";
import { SESSION_NAME } from "./pane-layout";
import type { ProcessProbe } from "./runs";

/** Where a run's pane agents open when `AWF_HERDR_SESSION` names nowhere else. */
const DEFAULT_RUN_SESSION = "awf";

/** What may start: the shared session is awf's by its name, since which run created it is not knowable. */
const OWN_SESSION = /^awf(-|$)/;

/**
 * The operator's variables a server starts with; a pane's login shell builds the rest. `HERDR_HOME`
 * and `XDG_*` move Herdr's own directory, which awf's calls to the session look in too.
 */
const SERVER_ENVIRONMENT = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "HERDR_HOME",
];
const SERVER_ENVIRONMENT_PREFIXES = ["LC_", "XDG_"];
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Only what makes noise; a headless server draws nothing, so the rest is Herdr's default. */
const QUIET_CONFIG = `# Written by awf for the Herdr sessions it starts; awf never overwrites it.
[ui.toast]
delivery = "off"

[ui.sound]
enabled = false
`;

const READY_POLL_MS = 200;
const READY_WITHIN_MS = 10_000;

/** Starts a server that outlives this process; settles once it has started, or could not. */
export type StartServer = (
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<void>;

export type RunSessionDeps = {
  run: RunProcess;
  environment: Readonly<Record<string, string | undefined>>;
  home: string;
  start?: StartServer;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** A process's start time, which tells a run's process from another that took its pid since. */
  probe?: ProcessProbe;
  /** Whether a pid is a process at all. */
  exists?: (pid: number) => boolean;
};

export type RunSession = {
  name: string;
  /** Whether this call started its server. */
  started: boolean;
  /** The Herdr it ran, when this call restarted it on the one installed. */
  restartedFrom?: string;
  /** The server's Herdr and the one installed, when they differ and it was not restarted. */
  stale?: { server: string; installed: string };
  /** Labels of `awf` workspaces whose run had ended, closed. */
  closed: string[];
  /** `awf` workspaces no run's mark names, made by hand or by an older awf, left open. */
  unclaimed: { id: string; label: string }[];
  /** Panes runs that ended kept, still open, in whatever session they are in. */
  kept?: KeptPane[];
};

export type KeptPane = { run: string; session: string; paneId: string };

/** `AWF_HERDR_SESSION`, else `awf`; refused when Herdr could not use it as a session name. */
export function runSessionName(environment: Readonly<Record<string, string | undefined>>): string {
  const name = environment.AWF_HERDR_SESSION || DEFAULT_RUN_SESSION;
  if (!SESSION_NAME.test(name)) {
    throw new Error(
      `AWF_HERDR_SESSION ${JSON.stringify(name)} is not a Herdr session name awf uses: lowercase letters, digits and -, up to 32, not starting with -`,
    );
  }
  return name;
}

/**
 * The Herdr session a run's pane agents open in, running and kept: started detached when down and
 * named `awf` or `awf-…`, from a minimal environment and a quiet config, so it outlives this run
 * for the next. Any other name that is down is refused: it may be an operator's stopped session,
 * and bringing it back headless is not awf's call. Then the workspaces of runs that ended are
 * closed, and a server older than the Herdr installed is restarted if nothing runs in it.
 */
export async function ensureRunSession(name: string, deps: RunSessionDeps): Promise<RunSession> {
  const { started, workspaces, sessionDir } = await runningSession(name, deps);
  const panes = await sweepPanes(deps);
  const kept = panes.kept.length > 0 ? { kept: panes.kept } : {};
  // A list that can't be read is no session found empty: nothing is closed or restarted.
  const swept = workspaces
    ? await sweepWorkspaces(name, workspaces, deps, panes.keptIn)
    : { closed: [], unclaimed: [], open: Number.POSITIVE_INFINITY };
  const { closed, unclaimed } = swept;
  const version = await serverVersion(name, deps);
  if (!version?.stale) return { name, started, closed, unclaimed, ...kept };
  const stale = { server: version.server, installed: version.installed };
  if (!OWN_SESSION.test(name) || swept.open > 0 || !(await stillUnused(name, deps))) {
    return { name, started, stale, closed, unclaimed, ...kept };
  }
  const stopped = await deps.run({ argv: ["herdr", "session", "stop", name], timeoutMs: 10_000 });
  if (stopped.exitCode !== 0) return { name, started, stale, closed, unclaimed, ...kept };
  await startServer(name, sessionDir, deps);
  return { name, started: true, restartedFrom: version.server, closed, unclaimed, ...kept };
}

/** `name`'s server, answering: started if down and awf's; its workspaces, if they could be read. */
async function runningSession(
  name: string,
  deps: RunSessionDeps,
): Promise<{
  started: boolean;
  workspaces: ListedWorkspace[] | undefined;
  sessionDir: string | undefined;
}> {
  const listed = await deps.run({
    argv: ["herdr", "session", "list", "--json"],
    timeoutMs: 10_000,
  });
  if (listed.exitCode !== 0) {
    throw new Error(`herdr session list failed: ${(listed.stderr || listed.stdout).trim()}`);
  }
  const sessionDir = parseSessions(listed.stdout).find((session) => session.name === name);
  // Listed running may be another run's server, not yet serving.
  if (sessionDir?.running === true) {
    return {
      started: false,
      workspaces: await answering(name, sessionDir.sessionDir, deps),
      sessionDir: sessionDir.sessionDir,
    };
  }
  if (!OWN_SESSION.test(name)) {
    throw new Error(
      `Herdr session ${name} is not running, and awf starts only sessions named awf or awf-…; start it with \`herdr --session ${name} server\``,
    );
  }
  // Two runs starting it at once both say so: the one that lost the race can't tell.
  return {
    started: true,
    workspaces: await startServer(name, sessionDir?.sessionDir, deps),
    sessionDir: sessionDir?.sessionDir,
  };
}

/**
 * Closes each workspace a dead run's mark names by id, and drops dead marks that name none still
 * open, or none at all. An `awf` workspace no mark names is left, and named. What stays open,
 * counted.
 */
async function sweepWorkspaces(
  name: string,
  workspaces: readonly ListedWorkspace[],
  deps: RunSessionDeps,
  /** Workspaces, as `{session}/{id}`, that hold a pane a run kept. */
  keptIn: ReadonlySet<string>,
): Promise<{ closed: string[]; unclaimed: { id: string; label: string }[]; open: number }> {
  const marks = await readMarks(deps.home, name);
  const dead = (mark: WorkspaceMark) =>
    mark.ended === true || liveness(mark, deps.probe, deps.exists) === "dead";
  /** A mark that still names a pane outlives the workspace it named. */
  const holds = (mark: WorkspaceMark) =>
    Object.values(mark.panes ?? {}).some((panes) => panes.length > 0);
  const closed: string[] = [];
  const unclaimed: { id: string; label: string }[] = [];
  let open = 0;
  for (const workspace of workspaces) {
    const own = marks.filter((mark) => mark.workspaceId === workspace.id);
    // A run between its mark and its workspace's id names it by label alone.
    const opening = marks.some(
      (mark) => mark.workspaceId === undefined && mark.label === workspace.label,
    );
    if (own.length === 0 && !opening && workspace.label.startsWith("awf "))
      unclaimed.push(workspace);
    if (own.length === 0 || !own.every(dead) || keptIn.has(`${name}/${workspace.id}`)) {
      open += 1;
      continue;
    }
    const closing = await deps.run({
      argv: ["herdr", "--session", name, "workspace", "close", workspace.id],
      timeoutMs: 10_000,
    });
    if (closing.exitCode !== 0) {
      open += 1;
      continue;
    }
    closed.push(workspace.label);
    for (const mark of own) {
      if (!holds(mark)) await removeMark(mark.file);
    }
  }
  const listed = new Set(workspaces.map((workspace) => workspace.id));
  for (const mark of marks) {
    const named = mark.workspaceId !== undefined && listed.has(mark.workspaceId);
    if (!named && dead(mark) && !holds(mark)) await removeMark(mark.file);
  }
  return { closed, unclaimed, open };
}

/**
 * Closes the panes of every run that ended, in each session its mark names, and leaves those it
 * kept, listed. A pane is closed only when its id and its terminal's both match, as Herdr's pane
 * ids repeat after a restart; one not there any more, or in a session gone, leaves its mark. A
 * session whose panes can't be read leaves them for the next sweep.
 */
async function sweepPanes(
  deps: RunSessionDeps,
): Promise<{ kept: KeptPane[]; keptIn: Set<string> }> {
  const kept: KeptPane[] = [];
  const keptIn = new Set<string>();
  const marks = (await readAllMarks(deps.home)).filter(
    (mark) =>
      mark.panes !== undefined &&
      (mark.ended === true || liveness(mark, deps.probe, deps.exists) === "dead"),
  );
  if (marks.length === 0) return { kept, keptIn };
  const sessions = await deps.run({
    argv: ["herdr", "session", "list", "--json"],
    timeoutMs: 10_000,
  });
  // A list that can't be read is no session found gone.
  if (sessions.exitCode !== 0) return { kept, keptIn };
  const running = new Set(
    parseSessions(sessions.stdout)
      .filter((session) => session.running)
      .map((session) => session.name),
  );
  const listings = new Map<string, Promise<ListedPane[] | undefined>>();
  const listed = (session: string) => {
    let listing = listings.get(session);
    if (!listing) {
      listing = deps
        .run({ argv: ["herdr", "--session", session, "pane", "list"], timeoutMs: 10_000 })
        .then((result) => (result.exitCode === 0 ? parsePanes(result.stdout) : undefined));
      listings.set(session, listing);
    }
    return listing;
  };
  for (const mark of marks) {
    const left: Record<string, MarkedPane[]> = {};
    for (const [session, panes] of Object.entries(mark.panes ?? {})) {
      if (!running.has(session)) continue;
      const open = await listed(session);
      if (!open) {
        left[session] = panes;
        continue;
      }
      const still: MarkedPane[] = [];
      for (const pane of panes) {
        const live = open.find(
          (candidate) =>
            candidate.id === pane.paneId &&
            pane.terminalId !== undefined &&
            candidate.terminalId === pane.terminalId,
        );
        if (!live) continue;
        if (pane.kept) {
          still.push(pane);
          kept.push({ run: mark.label, session, paneId: pane.paneId });
          keptIn.add(`${session}/${live.workspaceId ?? pane.workspaceId}`);
          continue;
        }
        const closing = await deps.run({
          argv: ["herdr", "--session", session, "pane", "close", pane.paneId],
          timeoutMs: 10_000,
        });
        if (closing.exitCode !== 0) still.push(pane);
      }
      if (still.length > 0) left[session] = still;
    }
    if (JSON.stringify(left) !== JSON.stringify(mark.panes)) {
      const { file, session: _session, ...rest } = mark;
      const cleared = { ...rest, panes: left };
      mark.panes = left;
      await rewriteMark(file, cleared);
    }
  }
  return { kept, keptIn };
}

type ListedPane = { id: string; terminalId?: string; workspaceId?: string };

/** `pane list`'s panes, undefined when unreadable. */
function parsePanes(stdout: string): ListedPane[] | undefined {
  let panes: unknown;
  try {
    panes = JSON.parse(stdout).result?.panes;
  } catch {
    return undefined;
  }
  if (!Array.isArray(panes)) return undefined;
  return panes.flatMap((pane) =>
    typeof pane?.pane_id === "string"
      ? [
          {
            id: pane.pane_id,
            ...(typeof pane.terminal_id === "string" ? { terminalId: pane.terminal_id } : {}),
            ...(typeof pane.workspace_id === "string" ? { workspaceId: pane.workspace_id } : {}),
          },
        ]
      : [],
  );
}

/**
 * Just before a restart: still no workspace, and no run that has not ended holding a mark. A mark
 * is written before its workspace, so a run opening one in the meantime is seen.
 */
async function stillUnused(name: string, deps: RunSessionDeps): Promise<boolean> {
  const listed = await deps.run({
    argv: ["herdr", "--session", name, "workspace", "list"],
    timeoutMs: 5_000,
  });
  const workspaces = listed.exitCode === 0 ? parseWorkspaces(listed.stdout) : undefined;
  if (workspaces === undefined || workspaces.length > 0) return false;
  const marks = await readMarks(deps.home, name);
  return marks.every((mark) => liveness(mark, deps.probe, deps.exists) === "dead");
}

/** Starts `name`'s server, as awf's own, and waits until it answers; its workspaces. */
async function startServer(
  name: string,
  sessionDir: string | undefined,
  deps: RunSessionDeps,
): Promise<ListedWorkspace[] | undefined> {
  const herdr = Bun.which("herdr", { PATH: deps.environment.PATH ?? "" });
  if (!herdr) throw new Error("herdr is not on PATH");
  const config = await quietConfig(deps.home);
  await (deps.start ?? startDetached)([herdr, "--session", name, "server"], {
    cwd: deps.home,
    env: { ...serverEnvironment(deps.environment), HERDR_CONFIG_PATH: config },
  }).catch((error: unknown) => {
    throw new Error(`could not start Herdr session ${name}: ${messageOf(error)}`);
  });
  return answering(name, sessionDir, deps);
}

/**
 * Whether the server runs a Herdr other than the one installed, as after `herdr update`: Herdr
 * says so itself. Undefined when it can't be read, which is no reason to stop a run.
 */
async function serverVersion(
  name: string,
  deps: RunSessionDeps,
): Promise<{ stale: boolean; server: string; installed: string } | undefined> {
  const status = await deps.run({
    argv: ["herdr", "--session", name, "status", "server", "--json"],
    timeoutMs: 10_000,
  });
  if (status.exitCode !== 0) return undefined;
  let read: { version?: unknown; server_binary_stale?: unknown; restart_needed?: unknown };
  try {
    read = JSON.parse(status.stdout);
  } catch {
    return undefined;
  }
  const stale = read.server_binary_stale === true || read.restart_needed === true;
  if (!stale) return { stale, server: String(read.version), installed: String(read.version) };
  const cli = await deps.run({ argv: ["herdr", "--version"], timeoutMs: 10_000 });
  const installed = /\d+\.\d+\.\d+\S*/.exec(cli.stdout)?.[0] ?? "unknown";
  return { stale, server: typeof read.version === "string" ? read.version : "unknown", installed };
}

/** The operator's allowlisted variables and a system `PATH`: nothing of the starting shell's own. */
export function serverEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = { PATH: SYSTEM_PATH };
  for (const [key, value] of Object.entries(environment)) {
    const allowed =
      SERVER_ENVIRONMENT.includes(key) ||
      SERVER_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (value !== undefined && allowed) {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * `~/.awf/herdr/config.toml`, written when absent and otherwise kept, so an operator may edit it.
 * Linked in whole, so a concurrent run never starts its server from a half-written one.
 */
async function quietConfig(home: string): Promise<string> {
  const file = join(machinePaths(home).herdr, "config.toml");
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, QUIET_CONFIG, { flag: "wx" });
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return file;
}

/**
 * Until the session answers. A start that lost a race to a concurrent run fails to bind, and this
 * finds the winner's server.
 */
async function answering(
  name: string,
  sessionDir: string | undefined,
  deps: RunSessionDeps,
): Promise<ListedWorkspace[] | undefined> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const by = now() + READY_WITHIN_MS;
  for (;;) {
    const listed = await deps.run({
      argv: ["herdr", "--session", name, "workspace", "list"],
      timeoutMs: Math.min(5_000, Math.max(1, by - now())),
    });
    if (listed.exitCode === 0) return parseWorkspaces(listed.stdout);
    if (now() >= by) {
      const log = sessionDir
        ? `its log is under ${sessionDir}`
        : "`herdr session list` says where its log is";
      throw new Error(
        `Herdr session ${name} did not answer within ${READY_WITHIN_MS / 1000}s; ${log}, and \`herdr session attach ${name}\` shows it`,
      );
    }
    await sleep(READY_POLL_MS);
  }
}

const startDetached: StartServer = (argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: "ignore",
    });
    child.once("spawn", () => resolve());
    child.once("error", reject);
    child.unref();
  });

type ListedWorkspace = { id: string; label: string };

/** `workspace list`'s workspaces, undefined when unreadable; one without an id or label is skipped. */
function parseWorkspaces(stdout: string): ListedWorkspace[] | undefined {
  let workspaces: unknown;
  try {
    workspaces = JSON.parse(stdout).result?.workspaces;
  } catch {
    return undefined;
  }
  if (!Array.isArray(workspaces)) return undefined;
  return workspaces.flatMap((workspace) =>
    typeof workspace?.workspace_id === "string" && typeof workspace.label === "string"
      ? [{ id: workspace.workspace_id, label: workspace.label }]
      : [],
  );
}

type ListedSession = { name: string; running: boolean; socketPath?: string; sessionDir?: string };

/** `herdr session list --json`, read leniently: an entry without a name is skipped. */
export function parseSessions(stdout: string): ListedSession[] {
  let sessions: unknown;
  try {
    sessions = JSON.parse(stdout).sessions;
  } catch {
    return [];
  }
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((session) =>
    typeof session?.name === "string"
      ? [
          {
            name: session.name,
            running: session.running === true,
            ...(typeof session.socket_path === "string" ? { socketPath: session.socket_path } : {}),
            ...(typeof session.session_dir === "string" ? { sessionDir: session.session_dir } : {}),
          },
        ]
      : [],
  );
}
