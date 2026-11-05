import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { WakeDid, WakeWhy } from "@agentswf/contract/records";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import { coordinatorSocketPath, liveCoordinatorSocket } from "./coordinator-socket";
import { messageOf } from "./errors";
import { exists } from "./files";
import { coordinatorDir } from "./machine";
import { wakeCause } from "./run-policy/waits";
import { statusOf, stuckOf } from "./run-state";
import {
  claimedOf,
  generateId,
  launchLog,
  type Run,
  readAttemptFiles,
  readAttempts,
  recordFailedLaunch,
  sameProcess,
} from "./runs";
import { exchange } from "./socket-exchange";
import { readWaits } from "./waits";

/**
 * What `wake` did to a run: why it did nothing when it did nothing, and what was due when it
 * started or continued it.
 */
export type Woken = {
  did: WakeDid;
  why?: WakeWhy;
  error?: string;
  cause?: "event" | "timer" | "crashed" | "failed";
};

/**
 * Starts or continues a run's attempt, returning once that attempt has claimed its number, so
 * its pid is recorded while the run's lock is held. `launch` names it: its output is
 * `launches/{launch}.log`, and the attempt it starts records it.
 */
export type Launch = (run: Run, file: string, launch: string) => Promise<void>;

export type WakeContext = {
  home: string;
  environment: Readonly<Record<string, string | undefined>>;
  /** The file a sender named; absent, the run's last attempt's. */
  file?: string;
  launch?: Launch;
  /** Asks a live run's wait to read its events again; false when it couldn't be reached. */
  nudge?: (run: Run) => Promise<boolean>;
  now?: () => number;
  /** False for a duplicate: a live run has the event already, and a nudge would tell it nothing. */
  nudgeLive?: boolean;
};

/**
 * The one policy for what an accepted event, or `awf tick`, does to a run: start it, nudge it,
 * continue it, or nothing. The caller holds the run's lock. A limit on live runs goes here.
 */
export async function wake(run: Run, context: WakeContext): Promise<Woken> {
  // Every attempt file, for `stuck` and the next number; what to do is decided from those that ran.
  const files = await readAttemptFiles(run);
  const claimed = claimedOf(files);
  const now = () => new Date(context.now?.() ?? Date.now());
  const launch = async (
    did: "started" | "continued",
    cause: NonNullable<Woken["cause"]>,
  ): Promise<Woken> => {
    const file = context.file ?? claimed.at(-1)?.file ?? run.record.file;
    const started = now();
    const id = generateId(started, randomBytes(3).toString("hex"));
    try {
      if (file === undefined) throw new Error(`${run.record.id} has no file to run`);
      await (context.launch ?? detachedLaunch(context))(run, file, id);
      return { did, cause };
    } catch (error) {
      // The event is in `in.jsonl`; the next wake tries again, until Q13's limit.
      const reason = messageOf(error);
      const recorded = await recordFailedLaunch(
        run,
        {
          attempt: (files.at(-1)?.attempt ?? 0) + 1,
          launch: id,
          file: file ?? "",
          started: started.toISOString(),
          reason,
        },
        now(),
      ).catch(() => true);
      // Its number is taken by an attempt that claimed it after all: the launch started it.
      if (!recorded) return { did, cause };
      return { did: "none", why: "launch-failed", error: reason };
    }
  };
  // A launch that never claimed its number counts towards `stuck` only: the run is woken as it was
  // before it.
  const stuck = () => stuckOf(files);
  if (claimed.length === 0)
    return stuck() ? { did: "none", why: "stuck" } : launch("started", "event");
  const { state } = statusOf(run, files);
  switch (state) {
    case "running":
      if (context.nudgeLive === false) return { did: "none" };
      return (await (context.nudge ?? nudgeOver(context))(run))
        ? { did: "nudged" }
        : { did: "none", why: "nudge-failed" };
    case "parked": {
      if (stuck()) return { did: "none", why: "stuck" };
      // Only for what the wait it parked at would take: an event it names, or its timer due.
      const at = now().getTime();
      const state = await readWaits(run.dir, at);
      const cause = wakeCause(state, state.lastWait?.takes);
      return cause ? launch("continued", cause) : { did: "none", why: "nothing-due" };
    }
    case "interrupted":
    case "failed":
    case "timed-out":
      return stuck()
        ? { did: "none", why: "stuck" }
        : launch("continued", state === "interrupted" ? "crashed" : "failed");
    case "stopped":
    case "cancelled":
      return { did: "none", why: state };
    case "stuck":
      return { did: "none", why: "stuck" };
    case "completed":
      return { did: "none", why: "returned" };
  }
}

/**
 * What a run's attempt is given of the environment of whoever woke it: who and where the engineer
 * is, the machine's plumbing (the ssh agent, proxies, XDG directories) and awf's own settings, and
 * the run's recorded `PATH`. Tokens, keys and harness settings come from the project's `.env`,
 * which Bun reads at every start and which a variable already set would override, so a run
 * behaves the same whoever sends, and a rotated token reaches it (Q15).
 */
export function attemptEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  run: Run,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && (KEPT.has(name) || KEPT_PREFIXES.some((p) => name.startsWith(p))))
      kept[name] = value;
  }
  return { ...kept, PATH: run.record.env?.PATH ?? environment.PATH ?? "" };
}

const KEPT = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // awf's own: where holders reach the run, and which Herdr session its panes open in.
  "AWF_COORDINATOR_DIR",
  "AWF_HERDR_SESSION",
]);
const KEPT_PREFIXES = ["LC_", "XDG_"];

/** A nudge over the run's socket, which a run with `events` opens at its start. */
function nudgeOver(context: WakeContext): (run: Run) => Promise<boolean> {
  return async (run) => {
    const dir = coordinatorDir(context.home, context.environment);
    const socket = await liveCoordinatorSocket(dir, { state: "running", run });
    if (!socket) return false;
    try {
      const answer = await exchange(
        socket,
        `${JSON.stringify({ version: WIRE_VERSION, command: "nudge" })}\n`,
        2_000,
      );
      return (JSON.parse(answer) as { code?: unknown }).code === "nudged";
    } catch {
      return false;
    }
  };
}

/** The awf command this engine ships, as a process runs it. */
const CLI = join(import.meta.dir, "operator-cli.ts");

/** How long a claimed attempt is given to open its socket before the launch returns anyway. */
const SOCKET_MILLISECONDS = 5_000;

/** How long a launched attempt has to claim its number before the launch gives up. */
const CLAIM_MILLISECONDS = 60_000;

/**
 * Runs `awf run {file} --id {id} --continue` in a session of its own (Q4), so it outlives the sender's
 * terminal, in the run's project with its recorded `PATH`, its output in `launches/{launch}.log`,
 * and `AWF_LAUNCH` naming it to the attempt. Bun reads the project's `.env` there, as at every
 * start, so a rotated token reaches it.
 */
function detachedLaunch(context: WakeContext): Launch {
  return async (run, file, launch) => {
    const before = (await readAttempts(run)).length;
    const path = launchLog(run.dir, launch);
    mkdirSync(join(run.dir, "launches"), { recursive: true, mode: 0o700 });
    const log = openSync(path, "a", 0o600);
    const env = { ...attemptEnvironment(context.environment, run), AWF_LAUNCH: launch };
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn({
        cmd: [
          process.execPath,
          CLI,
          "run",
          file,
          "--id",
          run.record.id,
          "--continue",
          "--run-root",
          run.root,
        ],
        cwd: run.record.cwd,
        env,
        stdio: ["ignore", log, log],
        detached: true,
      });
    } finally {
      closeSync(log);
    }
    child.unref();
    const giveUp = Date.now() + CLAIM_MILLISECONDS;
    for (;;) {
      const claimed = await readAttempts(run);
      if (claimed.length > before) {
        // The new attempt opens its socket only once the one before it is gone: no sender waits
        // on that.
        const previous = claimed.at(-2);
        if (previous && sameProcess(previous.pid, previous.processStart)) return;
        // A plain run opens its socket only when a participant connects: no sender nudges it.
        if (!run.record.events) return;
        // Best effort: an event sent next nudges the run rather than waiting for its poll.
        const socket = coordinatorSocketPath(coordinatorDir(context.home, env), run.dir);
        const opened = Date.now() + SOCKET_MILLISECONDS;
        while (
          Date.now() < opened &&
          child.exitCode === null &&
          child.signalCode === null &&
          !(await exists(socket))
        )
          await Bun.sleep(25);
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const tail = await Bun.file(path)
          .text()
          .then((text) => text.trim().split("\n").slice(-3).join(" / "))
          .catch((error: unknown) => messageOf(error));
        throw new Error(`the attempt of ${run.record.id} exited before it started: ${tail}`);
      }
      if (Date.now() > giveUp) {
        // One that claimed meanwhile goes on. Left running, one that did not could still claim the
        // run later, past the failed attempt its launcher writes: it is stopped, and waited for.
        if ((await readAttempts(run)).length > before) continue;
        await stopGroup(child);
        if ((await readAttempts(run)).length > before) continue;
        throw new Error(
          `the attempt of ${run.record.id} did not start within ${CLAIM_MILLISECONDS / 1000} s`,
        );
      }
      await Bun.sleep(25);
    }
  };
}

/**
 * Kills a launched child's process group outright, and waits for it: a `SIGTERM` would be a cancel
 * to `awf run`, which ends an event run for good.
 */
async function stopGroup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // It ended meanwhile.
  }
  await child.exited;
}
