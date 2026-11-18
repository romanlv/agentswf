import { createHash } from "node:crypto";

function git(dir: string, args: readonly string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  return { ok: run.exitCode === 0, out: run.stdout.toString() };
}

/** The top of the repository `dir` is in; undefined outside one. */
export function gitTop(dir: string): string | undefined {
  const { ok, out } = git(dir, ["rev-parse", "--show-toplevel"]);
  return ok ? out.trim() || undefined : undefined;
}

/**
 * What names a project whatever checkout it is in: its first commit (the oldest root, when there
 * are several) and the main checkout's folder name. Undefined outside a repository or before a
 * first commit.
 */
export function projectOf(dir: string): { name: string; first: string } | undefined {
  const roots = git(dir, ["rev-list", "--max-parents=0", "HEAD"]);
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!roots.ok || !common.ok) return undefined;
  const first = roots.out.split("\n").filter(Boolean).sort()[0];
  const gitDir = common.out.trim();
  if (!first || !gitDir) return undefined;
  const main = gitDir.endsWith("/.git") ? gitDir.slice(0, -"/.git".length) : gitDir;
  return { name: main.split("/").at(-1) ?? "project", first: first.slice(0, 12) };
}

/** Where a folder of code stands: its branch (null when detached), commit, and uncommitted changes. */
export function gitState(dir: string): {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
} {
  const head = git(dir, ["rev-parse", "HEAD"]);
  const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = git(dir, ["status", "--porcelain"]);
  return {
    branch: branch.ok ? branch.out.trim() || null : null,
    commit: head.ok ? head.out.trim() || null : null,
    dirty: status.ok && status.out.trim() !== "",
  };
}

/** Commits in batches, so a long history never overflows a command line. */
function allCommits(dir: string): string[] {
  const { ok, out } = git(dir, ["rev-list", "--all"]);
  return ok ? out.split("\n").filter(Boolean) : [];
}

/** Whether any commit of the repository at `dir` holds `text` in any file. */
export function historyHolds(dir: string, text: string): boolean {
  const commits = allCommits(dir);
  for (let at = 0; at < commits.length; at += 200) {
    const batch = commits.slice(at, at + 200);
    const run = git(dir, ["grep", "-l", "-F", "--no-color", "-e", text, ...batch, "--"]);
    if (run.ok && run.out.trim() !== "") return true;
  }
  return false;
}

/** Every blob id reachable in the repository at `dir`. */
export function blobIds(dir: string): Set<string> {
  const { ok, out } = git(dir, ["rev-list", "--all", "--objects"]);
  return new Set(
    ok
      ? out
          .split("\n")
          .map((line) => line.split(" ")[0]!)
          .filter(Boolean)
      : [],
  );
}

/** The id git gives a file's bytes as a blob. */
export function blobIdOf(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
