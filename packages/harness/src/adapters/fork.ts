import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { type AbsoluteDeadline, DeadlineExceededError } from "@agentswf/contract/workflow";
import type { NativeFork, SessionCopy } from "../adapter";
import type { ProcessInput, ProcessResult } from "../command";
import { type ForkPlan, harnessSpec } from "../spec";
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
