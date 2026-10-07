import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { type AbsoluteDeadline, DeadlineExceededError } from "@agentswf/contract/workflow";
import type { CallingSession, NativeFork, SessionCopy } from "../adapter";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import { record, text } from "../json";
import { type ForkPlan, harnessSpec } from "../spec";
import { harnessState } from "../state";
import type { Harness } from "../types";

/** A fork asks no model: it copies a session file, in seconds (F7). */
export const FORK_ACTIVATION_MS = 60_000;

/** A fork run as a new agent is activated: within its deadline, and a minute at most. */
export function forkDeadline(deadline: AbsoluteDeadline): AbsoluteDeadline {
  return {
    unixMilliseconds: Math.min(deadline.unixMilliseconds, Date.now() + FORK_ACTIVATION_MS),
  };
}

/** The process a fork plan runs as, bounded by `deadline`. */
export function forkCommand(
  plan: ForkPlan,
  options: {
    cwd: string;
    env: Record<string, string>;
    deadline: AbsoluteDeadline;
    signal: AbortSignal;
  },
): ProcessInput & { env: Record<string, string> } {
  const remaining = options.deadline.unixMilliseconds - Date.now();
  if (remaining <= 0) throw new DeadlineExceededError(options.deadline);
  return {
    argv: plan.argv,
    cwd: options.cwd,
    env: options.env,
    ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
    ...(plan.holdStdinUntil ? { holdStdinUntil: plan.holdStdinUntil } : {}),
    timeoutMs: Math.max(1, remaining),
    signal: options.signal,
  };
}

/** What the fork plan's process left: the new session, or why there is none. */
export async function forkResult(
  harness: Harness,
  plan: ForkPlan,
  result: ProcessResult,
  deadline: AbsoluteDeadline,
): Promise<NativeFork> {
  if (result.cancelled) throw new Error("the fork was cancelled");
  // A held server answered before it was made to exit: its exit says nothing about the fork.
  if (!result.answered) {
    if (result.timedOut) throw new DeadlineExceededError(deadline);
    if (result.exitCode !== 0) {
      throw new Error(
        `${plan.argv[0]} exited ${result.exitCode} forking: ${result.stderr.trim().slice(0, 400)}`,
      );
    }
  }
  const read = plan.read(result.stdout);
  if ("error" in read) throw new Error(read.error);
  await plan.finish?.(read.sessionId);
  return {
    harness,
    sessionRef: read.sessionId,
    ...(read.costTotal === undefined ? {} : { costTotal: read.costTotal }),
  };
}

/**
 * Copies session `session` out of `home` into `into`, each file at its path in that home, for a
 * fork whose home is another. Nothing is copied through a link: the home may be a sandboxed
 * agent's, which it can write, and a link there would carry the operator's files out.
 */
export async function copySession(
  harness: Harness,
  home: string,
  session: string,
  cwd: string,
  into: SessionCopy,
): Promise<NativeFork> {
  const files = await harnessSpec(harness).sessionFiles?.(home, session, cwd);
  if (!files?.length) throw new Error(`${harness} found no session ${session} to fork`);
  for (const file of files) {
    if (isAbsolute(file) || file.split(sep).includes("..")) {
      throw new Error(`${file} is not in the agent's home`);
    }
    let path = home;
    for (const part of file.split(sep).slice(0, -1)) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a link`);
    }
    path = join(home, file);
    // Opened without following a link, and only a regular file of its own: a link swapped in after
    // the check, a FIFO that would hang the parent's queue, or a hard link to another file are not.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      throw new Error(error.code === "ELOOP" ? `${path} is a link` : error.message);
    });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${path} is not a file of its own`);
      const to = join(into.directory, file);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await writeFile(to, await handle.readFile(), { mode: 0o600 });
    } finally {
      await handle.close();
    }
  }
  return { harness, sessionRef: session, copied: true };
}

/**
 * Session `session` of `harness`, as the operator's home holds it: the directory its file last
 * records, falling back to `cwd`; when it was last written; and the model its last request ran on,
 * where its files name one. Undefined where it is not there.
 */
export async function findSession(
  harness: Harness,
  session: string,
  cwd: string,
  environment?: Readonly<Record<string, string | undefined>>,
): Promise<{ cwd: string; writtenAt: number; model?: string } | undefined> {
  const home = harnessState(environment)[harness];
  const files = await harnessSpec(harness).sessionFiles?.(home, session, cwd);
  if (!files?.length) return undefined;
  const written = await Promise.all(
    files.map((file) =>
      stat(join(home, file)).then(
        ({ mtimeMs }) => mtimeMs,
        () => 0,
      ),
    ),
  );
  const at = (await recordedCwd(join(home, files[0]!))) ?? cwd;
  const model = await lastModel(harness, session, at, home);
  return { cwd: at, writtenAt: Math.max(...written), ...(model ? { model } : {}) };
}

/**
 * The working directory the last row of a session's file that names one records: each row of
 * claude's, codex's `session_meta` and `turn_context`, pi's header.
 */
async function recordedCwd(file: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await Bun.file(file).text();
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of content.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const row = record(JSON.parse(line));
      found = text(row?.cwd) ?? text(record(row?.payload)?.cwd) ?? found;
    } catch {}
  }
  return found;
}

/**
 * The session a run was started from, which it forks but never started (story 027): in the
 * operator's home, with the operator's skills, and with none of the run's own place.
 */
export function callingSession(
  found: { harness: Harness; session: string; cwd: string },
  run: RunProcess,
  /** Waits for the session to settle first, where the run drives it; absent, it is read as is. */
  settle?: (deadline: AbsoluteDeadline, signal: AbortSignal) => Promise<void>,
  environment?: Readonly<Record<string, string | undefined>>,
): CallingSession {
  const { harness, session, cwd } = found;
  const spec = harnessSpec(harness);
  const home = harnessState(environment)[harness];
  return {
    harness,
    session,
    cwd,
    async fork(deadline, into, stop) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(Math.max(1, deadline.unixMilliseconds - Date.now())),
        ...(stop ? [stop] : []),
      ]);
      await settle?.(deadline, signal);
      const model = await lastModel(harness, session, cwd, home);
      if (!model) {
        throw new Error(
          `the calling session's files name no model it ran on (${harness} session ${session}), so its fork has none to run on`,
        );
      }
      if (signal.aborted) throw new Error("the fork was cancelled");
      if (into) {
        const copied = await copySession(harness, home, session, cwd, into);
        return { ...copied, model };
      }
      if (!spec.forkSession) throw new Error(`${harness} cannot fork`);
      const plan = await spec.forkSession(session, randomUUID(), { model, sessionHint: session });
      const command = forkCommand(plan, { cwd, env: {}, deadline, signal });
      return { ...(await forkResult(harness, plan, await run(command), deadline)), model };
    },
  };
}

/**
 * The model `session`'s last request ran on, read once: the operator chose it, and awf learns it
 * only from the session's files. A session waiting on the run is mid-turn until the run ends.
 */
async function lastModel(
  harness: Harness,
  session: string,
  cwd: string,
  home: string,
): Promise<string | undefined> {
  const spec = harnessSpec(harness);
  const read = await spec.readSessionUsage?.([session], cwd, home).catch(() => undefined);
  const last = read?.records
    .filter((each) => !each.delegated && each.model !== "unknown")
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .at(-1);
  return last && (spec.launchModel?.(last) ?? last.model);
}
