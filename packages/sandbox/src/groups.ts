import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** A shell script that records its pid in `$0`, then becomes the command in `$@`. */
export const RECORD_LEADER = 'mkdir -p "$(dirname "$0")" && echo $$ > "$0" && exec "$@"';

/**
 * A shell script that kills, where the host's `process.kill` cannot reach, the group each pid file
 * among its arguments names, or each one in a directory among them, and forgets it. A pid that is
 * not a number above 1 is skipped: `kill -9 -1` would take every process of the uid.
 */
export const KILL_GROUPS = `for a in "$@"; do for f in "$a" "$a"/*; do [ -f "$f" ] || continue; p=$(cat "$f"); case "$p" in ''|*[!0-9]*|0|1) ;; *) kill -9 -"$p" 2>/dev/null;; esac; rm -f "$f"; done; done; true`;

/**
 * The process groups one agent's launches lead, each named by a pid file its leader writes, so a
 * provider can end what an agent still runs at `release` and `close`: a turn left finishing, or
 * one a caller never killed. `runProcess` makes each launch a group leader (`setsid`).
 */
export class LaunchedGroups {
  constructor(private readonly directory: string) {}

  /** A fresh pid file, in a directory that exists, for a leader that records itself: a pane's. */
  async pidFile(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return join(this.directory, randomUUID());
  }

  /** `argv`, run by a shell that records its pid and then becomes it. */
  wrap(argv: readonly string[]): { argv: string[]; pidFile: string } {
    const pidFile = join(this.directory, randomUUID());
    return {
      argv: ["/bin/sh", "-c", RECORD_LEADER, pidFile, ...argv],
      pidFile,
    };
  }

  /**
   * Kills the group whose leader wrote `pidFile`. A group id stays reserved while any member
   * lives, and no process takes a live group's id, so the one risk is a leader whose group is
   * gone and whose pid a new process has taken: a pane's file stays until release. A process
   * holding the pid that started after the file was written is that one, and is left alone.
   */
  async kill(pidFile: string): Promise<void> {
    const [text, written] = await Promise.all([
      readFile(pidFile, "utf8").catch(() => ""),
      stat(pidFile).then(
        (found) => found.mtimeMs,
        () => undefined,
      ),
    ]);
    const pid = Number(text.trim());
    const started = Number.isSafeInteger(pid) && pid > 1 ? startedAt(pid) : undefined;
    // `ps` gives whole seconds. With the leader gone, what is left of its group is killed.
    const reused = started !== undefined && written !== undefined && started > written + 1_000;
    if (Number.isSafeInteger(pid) && pid > 1 && !reused) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(pidFile, { force: true });
  }

  /** Kills every group still recorded, and forgets them. */
  async killAll(): Promise<void> {
    const files = await readdir(this.directory).catch(() => []);
    await Promise.all(files.map((file) => this.kill(join(this.directory, file))));
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** When the process `pid` started, in milliseconds, or undefined when there is none. */
function startedAt(pid: number): number | undefined {
  const listed = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { PATH: "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC" },
  });
  const started = Date.parse(`${listed.stdout.toString().trim()} UTC`);
  return listed.exitCode === 0 && Number.isFinite(started) ? started : undefined;
}
