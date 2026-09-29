import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function succeeds(cwd: string, args: readonly string[]): boolean {
  return (
    Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0
  );
}

/** The clone's commit on `branch`, from its remote-tracking ref or else its local branch. */
export function branchTip(clone: string, branch: string): string {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    if (succeeds(clone, ["rev-parse", "--verify", "--quiet", ref])) {
      return git(clone, ["rev-parse", ref]);
    }
  }
  throw new Error(`the clone has no ${branch} branch to bundle against`);
}

/**
 * The remote old commits are fetched from: `explicit`, or the clone's origin, with a local path
 * resolved against the clone rather than wherever git happens to run.
 */
export function remoteOf(clone: string, explicit?: string): string {
  const url = explicit ?? git(clone, ["remote", "get-url", "origin"]);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\s]+@[^/\s]+:/.test(url);
  return isUrl || isAbsolute(url) ? url : resolve(clone, url);
}

/**
 * A throwaway bare repository that borrows the clone's objects, so fetching old commits never
 * touches the operator's clone.
 */
export class Scratch {
  readonly dir: string;

  constructor(readonly clone: string) {
    if (git(clone, ["rev-parse", "--is-shallow-repository"]) === "true") {
      throw new Error(`${clone} is a shallow clone; collect needs full history`);
    }
    if (succeeds(clone, ["config", "--get", "extensions.partialClone"])) {
      throw new Error(`${clone} is a partial clone; bundles need every object`);
    }
    const common = git(clone, ["rev-parse", "--git-common-dir"]);
    const objects = join(isAbsolute(common) ? common : resolve(clone, common), "objects");
    this.dir = mkdtempSync(join(tmpdir(), "awf-collect-"));
    try {
      git(this.dir, ["init", "--quiet", "--bare"]);
      writeFileSync(join(this.dir, "objects", "info", "alternates"), `${objects}\n`);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  git(args: readonly string[]): string {
    return git(this.dir, args);
  }

  has(sha: string): boolean {
    return succeeds(this.dir, ["cat-file", "-e", `${sha}^{commit}`]);
  }

  /**
   * Fetches what is missing, one at a time if the batch fails, and returns what the remote no
   * longer serves. A remote that can't be reached at all is an error, not missing commits.
   */
  fetch(remote: string, shas: readonly string[]): string[] {
    const missing = [...new Set(shas)].filter((sha) => !this.has(sha));
    if (missing.length === 0) return [];
    if (!succeeds(this.dir, ["ls-remote", "--heads", remote])) {
      throw new Error(`can't reach ${remote} to fetch old commits`);
    }
    if (!succeeds(this.dir, ["fetch", "--quiet", "--no-tags", remote, ...missing])) {
      for (const sha of missing) succeeds(this.dir, ["fetch", "--quiet", "--no-tags", remote, sha]);
    }
    return missing.filter((sha) => !this.has(sha));
  }

  /**
   * Bundles `refs` without what a clone of the main branch already has. A commit already on the
   * main branch is still included itself, since git refuses an empty bundle.
   */
  bundle(file: string, refs: readonly { name: string; sha: string }[], mainTip: string): void {
    const exclude = new Set<string>();
    for (const { sha } of refs) {
      const base = this.git(["merge-base", sha, mainTip]);
      if (base !== sha) exclude.add(base);
      else
        for (const parent of this.git(["rev-parse", `${sha}^@`]).split("\n")) exclude.add(parent);
    }
    // An exclusion that is, or descends from, another ref's tip would silently drop that ref.
    const kept = [...exclude].filter(
      (x) =>
        x && !refs.some(({ sha }) => succeeds(this.dir, ["merge-base", "--is-ancestor", sha, x])),
    );
    for (const { name, sha } of refs) this.git(["update-ref", name, sha]);
    try {
      const not = kept.map((sha) => `^${sha}`);
      this.git(["bundle", "create", "--quiet", file, ...refs.map((ref) => ref.name), ...not]);
    } finally {
      for (const { name } of refs) this.git(["update-ref", "-d", name]);
    }
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The commits a bundle needs but does not carry: the `-<id>` lines of its text header. */
async function bundlePrerequisites(file: string): Promise<string[]> {
  const start = await Bun.file(file)
    .slice(0, 64 * 1024)
    .text();
  const header = start.slice(0, start.indexOf("\n\n"));
  return header
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1).split(" ")[0]!);
}

const QUIET = ["-c", "core.logAllRefUpdates=false"];

/**
 * Fetches `refspec` from a bundle into `repo`, first taking the commits the bundle builds on from
 * `clone`, which only needs the main branch.
 */
export async function fetchBundle(
  repo: string,
  bundle: string,
  clone: string,
  refspec: string,
): Promise<void> {
  const prerequisites = await bundlePrerequisites(bundle);
  if (prerequisites.length > 0) {
    try {
      git(repo, [...QUIET, "fetch", "--quiet", "--no-tags", clone, ...prerequisites]);
    } catch (error) {
      throw new Error(
        `the clone lacks commits ${bundle} builds on; update its main branch and retry (${String(error)})`,
      );
    }
  }
  git(repo, [...QUIET, "fetch", "--quiet", "--no-tags", bundle, refspec]);
}

/** The clone's default branch, as `origin/HEAD` names it: what a fresh clone checks out. */
export function defaultBranch(clone: string): string {
  const ref = Bun.spawnSync(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: clone,
    stdout: "pipe",
    stderr: "ignore",
  });
  const name = ref.stdout.toString().trim();
  // A branch renamed upstream leaves origin/HEAD naming one that no longer exists.
  if (
    ref.exitCode !== 0 ||
    !name.startsWith("origin/") ||
    !succeeds(clone, ["rev-parse", "--verify", "--quiet", name])
  ) {
    throw new Error(
      `${clone} has no origin/HEAD to name its default branch; run git remote set-head origin --auto there`,
    );
  }
  return name.slice("origin/".length);
}

/**
 * Restores `ref` from a snapshot bundle into a fresh repository at `target`, with a branch `review`
 * at the frozen head. It holds that head and its ancestors only, and with `base`, base and its
 * ancestors: nothing newer, no remote, and no reflog, which would name the bundle's path and so the
 * MR. With `base`, it is laid out as the reviewer's clone was: the clone's default branch at
 * `base`, locally and as `origin/{branch}` with `origin/HEAD`, so `origin/main...HEAD` is the
 * change under review.
 */
export async function restore(options: {
  bundle: string;
  ref: string;
  clone: string;
  target: string;
  base?: string;
}): Promise<string> {
  const { bundle, ref, clone, target, base } = options;
  mkdirSync(target, { recursive: true });
  git(target, ["init", "--quiet"]);
  await fetchBundle(target, bundle, clone, `${ref}:refs/heads/review`);
  if (base) {
    const branch = defaultBranch(clone);
    // A base main moved to after the MR branched is in neither the bundle nor head's history.
    if (!succeeds(target, ["cat-file", "-e", `${base}^{commit}`])) {
      try {
        git(target, [...QUIET, "fetch", "--quiet", "--no-tags", clone, base]);
      } catch (error) {
        throw new Error(
          `the clone lacks ${base}, the case's base; update its default branch and retry (${String(error)})`,
        );
      }
    }
    git(target, [...QUIET, "update-ref", `refs/heads/${branch}`, base]);
    git(target, [...QUIET, "update-ref", `refs/remotes/origin/${branch}`, base]);
    git(target, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
  }
  git(target, [...QUIET, "checkout", "--quiet", "review"]);
  for (const leftover of ["FETCH_HEAD", "logs"]) {
    rmSync(join(target, ".git", leftover), { recursive: true, force: true });
  }
  return git(target, ["rev-parse", "HEAD"]);
}

/**
 * A temp directory by its real path, which is how sandboxes record paths and the only one docker
 * mounts: `/var/folders/…` is `/private/var/folders/…` on macOS.
 */
export function scratchDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
