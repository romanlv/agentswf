import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  MAILBOX_RECORD_VERSION,
  type MailboxRecord,
  type WakeDid,
  type WakeWhy,
} from "@agentswf/contract/records";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import { coordinatorSocketPath, liveCoordinatorSocket } from "./coordinator-socket";
import { messageOf } from "./errors";
import { exists } from "./files";
import { coordinatorDir } from "./machine";
import { appendMailbox, foldMailbox, hasWork, readMailbox, readyFor } from "./mailbox";
import { statusOf, stuckOf } from "./run-state";
import { type Run, readAttempts, sameProcess } from "./runs";
import { exchange } from "./socket-exchange";

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
 * its pid is recorded while the run's lock is held.
 */
export type Launch = (run: Run, file: string) => Promise<void>;

export type WakeContext = {
  home: string;
  environment: Readonly<Record<string, string | undefined>>;
  /** The file a sender named; absent, the run's last attempt's. */
  file?: string;
  launch?: Launch;
  /** Asks a live run's wait to read its mailbox again; false when it couldn't be reached. */
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
  const attempts = await readAttempts(run);
  let read: MailboxRecord[] | undefined;
  const mailbox = async () => {
    read ??= await readMailbox(run.dir);
    return read;
  };
  const launch = async (
    did: "started" | "continued",
    cause: NonNullable<Woken["cause"]>,
  ): Promise<Woken> => {
    const file = context.file ?? attempts.at(-1)?.file ?? run.record.file;
    try {
      if (file === undefined) throw new Error(`${run.record.id} has no file to run`);
      await (context.launch ?? detachedLaunch(context))(run, file);
      return { did, cause };
    } catch (error) {
      // The event is in the mailbox; the next wake tries again, until Q13's limit.
      const reason = messageOf(error);
      read = undefined;
      await appendMailbox(run.dir, {
        version: MAILBOX_RECORD_VERSION,
        at: new Date(context.now?.() ?? Date.now()).toISOString(),
        kind: "launch-failed",
        reason,
      });
      return { did: "none", why: "launch-failed", error: reason };
    }
  };
  const stuck = async () => stuckOf(attempts, await mailbox());
  if (attempts.length === 0)
    return (await stuck()) ? { did: "none", why: "stuck" } : launch("started", "event");
  const { state } = statusOf(run, attempts);
  switch (state) {
    case "running":
      if (context.nudgeLive === false) return { did: "none" };
      return (await (context.nudge ?? nudgeOver(context))(run))
        ? { did: "nudged" }
        : { did: "none", why: "nudge-failed" };
    case "parked": {
      if (await stuck()) return { did: "none", why: "stuck" };
      // Only for what the wait it parked at would take: an event it names, or its timer due.
      const state = foldMailbox(await mailbox());
      const takes = state.lastWait?.takes;
      if (!hasWork(state, takes, context.now?.() ?? Date.now()))
        return { did: "none", why: "nothing-due" };
      return launch("continued", readyFor(state, takes).length > 0 ? "event" : "timer");
    }
    case "interrupted":
    case "failed":
    case "timed-out":
      return (await stuck())
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
 * terminal, in the run's project with its recorded `PATH`, its output in the run's `process.log`.
 * Bun reads the project's `.env` there, as at every start, so a rotated token reaches it.
 */
function detachedLaunch(context: WakeContext): Launch {
  return async (run, file) => {
    const before = (await readAttempts(run)).length;
    // Only what this launch writes is quoted if it fails: the log holds every attempt's output.
    const from = Bun.file(join(run.dir, "process.log")).size;
    const log = openSync(join(run.dir, "process.log"), "a", 0o600);
    const env = attemptEnvironment(context.environment, run);
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
        const tail = await Bun.file(join(run.dir, "process.log"))
          .slice(from)
          .text()
          .then((text) => text.trim().split("\n").slice(-3).join(" / "))
          .catch((error: unknown) => messageOf(error));
        throw new Error(`the attempt of ${run.record.id} exited before it started: ${tail}`);
      }
      if (Date.now() > giveUp) {
        // One that claimed meanwhile goes on. Left running, one that did not could still claim the
        // run later and race the next launch.
        if ((await readAttempts(run)).length > before) continue;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // It ended meanwhile.
        }
        throw new Error(
          `the attempt of ${run.record.id} did not start within ${CLAIM_MILLISECONDS / 1000} s`,
        );
      }
      await Bun.sleep(25);
    }
  };
}
