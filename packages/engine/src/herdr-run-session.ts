import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunProcess } from "@agentswf/harness";
import { messageOf } from "./errors";
import { machinePaths } from "./machine";

/** Where a run's pane agents open when `AWF_HERDR_SESSION` names nowhere else. */
const DEFAULT_RUN_SESSION = "awf";

/** Herdr makes `sessions/{name}` from it; a leading `-` reads as an option, a long one overflows the socket path. */
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

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
};

export type RunSession = {
  name: string;
  /** Whether this call started its server. */
  started: boolean;
};

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
 * The Herdr session a run's pane agents open in, running: started detached when down and named
 * `awf` or `awf-…`, from a minimal environment and a quiet config, so it outlives this run for the
 * next. Any other name that is down is refused: it may be an operator's stopped session, and
 * bringing it back headless is not awf's call.
 */
export async function ensureRunSession(name: string, deps: RunSessionDeps): Promise<RunSession> {
  const { run } = deps;
  const listed = await run({ argv: ["herdr", "session", "list", "--json"], timeoutMs: 10_000 });
  if (listed.exitCode !== 0) {
    throw new Error(`herdr session list failed: ${(listed.stderr || listed.stdout).trim()}`);
  }
  const listedSession = parseSessions(listed.stdout).find((session) => session.name === name);
  // Listed running may be another run's server, not yet serving.
  if (listedSession?.running === true) {
    await answering(name, listedSession.sessionDir, deps);
    return { name, started: false };
  }
  if (!OWN_SESSION.test(name)) {
    throw new Error(
      `Herdr session ${name} is not running, and awf starts only sessions named awf or awf-…; start it with \`herdr --session ${name} server\``,
    );
  }
  const herdr = Bun.which("herdr", { PATH: deps.environment.PATH ?? "" });
  if (!herdr) throw new Error("herdr is not on PATH");
  const config = await quietConfig(deps.home);
  await (deps.start ?? startDetached)([herdr, "--session", name, "server"], {
    cwd: deps.home,
    env: { ...serverEnvironment(deps.environment), HERDR_CONFIG_PATH: config },
  }).catch((error: unknown) => {
    throw new Error(`could not start Herdr session ${name}: ${messageOf(error)}`);
  });
  await answering(name, listedSession?.sessionDir, deps);
  // Two runs starting it at once both say so: the one that lost the race can't tell.
  return { name, started: true };
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
  const file = join(machinePaths(home).root, "herdr", "config.toml");
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
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const by = now() + READY_WITHIN_MS;
  for (;;) {
    const listed = await deps.run({
      argv: ["herdr", "--session", name, "workspace", "list"],
      timeoutMs: Math.min(5_000, Math.max(1, by - now())),
    });
    if (listed.exitCode === 0) return;
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
