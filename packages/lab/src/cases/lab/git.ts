import { createHash } from "node:crypto";

function tryGit(dir: string, args: readonly string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  return { ok: run.exitCode === 0, out: run.stdout.toString() };
}

/**
 * Git in `dir`, its stdout; throws with git's stderr when it fails. Commits are the lab's own, so
 * they need no identity of the operator's.
 */
export function git(dir: string, args: readonly string[], stdin?: string): string {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=awf-lab", "-c", "user.email=awf-lab@localhost", "-C", dir, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    },
  );
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir}: ${run.stderr.toString().trim()}`);
  }
  return run.stdout.toString();
}

/** The top of the repository `dir` is in; undefined outside one. */
export function gitTop(dir: string): string | undefined {
  const { ok, out } = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return ok ? out.trim() || undefined : undefined;
}

/**
 * What names a project whatever checkout it is in: its first commit (the oldest root, when there
 * are several) and the main checkout's folder name. Undefined outside a repository or before a
 * first commit.
 */
export function projectOf(dir: string): { name: string; first: string } | undefined {
  const roots = tryGit(dir, ["rev-list", "--max-parents=0", "HEAD"]);
  const common = tryGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
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
  const head = tryGit(dir, ["rev-parse", "HEAD"]);
  const branch = tryGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = tryGit(dir, ["status", "--porcelain"]);
  return {
    branch: branch.ok ? branch.out.trim() || null : null,
    commit: head.ok ? head.out.trim() || null : null,
    dirty: status.ok && status.out.trim() !== "",
  };
}

/**
 * Whether any object of the repository at `dir` holds `text`: every commit, tree and blob read
 * once, whether a ref reaches it or not. One pass, not a grep of each commit's tree, which took
 * minutes on a long history (story 044's M6).
 */
export function historyHolds(dir: string, text: string): boolean {
  const run = Bun.spawnSync(
    [
      "sh",
      "-c",
      'git -C "$1" cat-file --batch-all-objects --batch --unordered | grep -aqF -e "$2"',
      "sh",
      dir,
      text,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  return run.exitCode === 0;
}

/** Every blob id in the repository at `dir`, whether a ref reaches it or not. */
export function blobIds(dir: string): Set<string> {
  const { ok, out } = tryGit(dir, [
    "cat-file",
    "--batch-all-objects",
    "--unordered",
    "--batch-check=%(objectname) %(objecttype)",
  ]);
  if (!ok) return new Set();
  return new Set(
    out
      .split("\n")
      .filter((line) => line.endsWith(" blob"))
      .map((line) => line.slice(0, line.indexOf(" "))),
  );
}

/** The id git gives a file's bytes as a blob. */
export function blobIdOf(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
