import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contains } from "./resolve";
import type { ResolvedSandbox } from "./seam";

/**
 * What in a writable gitdir the host's git runs, or follows to config it would run: hooks and
 * config; `commondir`, `gitdir` and `config.worktree`, which point it elsewhere; submodules'
 * gitdirs; and `info/`. The rest (objects, refs, the index, `HEAD`) is what a commit writes.
 */
const GIT_PROTECTED = [
  "hooks",
  "config",
  "config.worktree",
  "commondir",
  "gitdir",
  "modules",
  "info",
] as const;

/** A worktree's own state in its gitdir, which another worktree's commit leaves. */
const WORKTREE_STATE = ["index", "HEAD"] as const;

/**
 * What the operator's tools run from a directory they work in, unasked: srt's own list, which it
 * denies anywhere, and claude's project settings, whose hooks run on the host's next claude there.
 */
const HOST_RUN = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
  ".claude/commands",
  ".claude/agents",
  ".claude/settings.json",
  ".claude/settings.local.json",
] as const;

/**
 * Every path an agent must not write, whether it exists yet or not, so the host runs nothing an
 * agent planted: each writable gitdir's protected parts, and those of every worktree kept inside
 * it; the state of every worktree out of reach, the main one's included, which the operator
 * commits from; the `.git` pointers of worktrees and submodules in writable paths, which
 * rewritten would point the host's git at a gitdir an agent made; hooks `core.hooksPath` puts in a
 * writable path; host-run config at the root of each writable path, worktree and clone; and what
 * any of these, being a link, names in a writable path. Every provider holds the same list.
 */
export async function protectedPaths(spec: ResolvedSandbox<unknown>): Promise<string[]> {
  const writable = spec.gitdirs.filter((gitdir) => gitdir.writable);
  const inWrite = (path: string) => spec.write.some((root) => contains(root, path));
  const gitdirs = new Set(writable.map(({ path }) => path));
  // Whose worktree is in reach: the others' state is theirs to stage and check out.
  const own = new Set(writable.filter((gitdir) => !gitdir.linked).map(({ path }) => path));
  const others: string[] = [];
  const pointers: string[] = [];
  for (const { path } of writable) {
    for (const name of await readdir(join(path, "worktrees")).catch(() => [])) {
      const worktree = join(path, "worktrees", name);
      gitdirs.add(worktree);
      if (!own.has(worktree)) others.push(worktree);
      // Git keeps where each worktree's pointer is.
      const pointer = await readFile(join(worktree, "gitdir"), "utf8").catch(() => undefined);
      if (pointer?.trim()) pointers.push(resolve(worktree, pointer.trim()));
    }
    pointers.push(...(await submodulePointers(join(path, "modules"))));
  }
  const guarded = pointers.filter(inWrite);
  // Where the host's tools work: each writable path, and each worktree and clone inside one.
  const roots = [
    ...spec.write,
    ...guarded.map(dirname),
    ...writable
      .filter(({ path }) => basename(path) === ".git" && inWrite(path))
      .map(({ path }) => dirname(path)),
  ];
  // `core.hooksPath` puts hooks outside the gitdir, relative to a worktree's root, often in it.
  const hooks: string[] = [];
  for (const { path } of writable) {
    for (const name of ["config", "config.worktree"]) {
      const config = await readFile(join(path, name), "utf8").catch(() => "");
      for (const [, value = ""] of config.matchAll(/^\s*hookspath\s*=\s*(.+?)\s*$/gim)) {
        const named = value.replace(/^"(.*)"$/, "$1");
        // Every worktree's root: a repository's config holds for each of them.
        const worktrees = [
          ...(basename(path) === ".git" ? [dirname(path)] : []),
          ...guarded.map(dirname),
        ];
        hooks.push(
          ...(isAbsolute(named) ? [named] : worktrees.map((root) => resolve(root, named))),
        );
      }
    }
  }
  const listed = [
    ...new Set([
      ...[...gitdirs].flatMap((gitdir) => GIT_PROTECTED.map((name) => join(gitdir, name))),
      ...[...writable.filter((gitdir) => gitdir.linked).map(({ path }) => path), ...others].flatMap(
        (gitdir) => WORKTREE_STATE.map((name) => join(gitdir, name)),
      ),
      ...guarded,
      ...hooks.filter(inWrite),
      ...roots.flatMap((root) => HOST_RUN.map((name) => join(root, name))),
    ]),
  ];
  // One that is, or is under, a link into a writable path is written through there: that path is
  // guarded too, whether it exists yet or not.
  const targets = await Promise.all(
    listed.map(async (path) => {
      const real = await realpathOf(path);
      return real !== path && inWrite(real) ? [real] : [];
    }),
  );
  return [...new Set([...listed, ...targets.flat()])];
}

/**
 * The `.git` pointer of each submodule whose gitdir is under `modules`, nested ones included: a
 * module's gitdir names its worktree in its config's `core.worktree`.
 */
async function submodulePointers(modules: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const config = await readFile(join(directory, "config"), "utf8").catch(() => undefined);
    if (config !== undefined) {
      const worktree = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config)?.[1];
      if (worktree) found.push(join(resolve(directory, worktree), ".git"));
      await visit(join(directory, "modules"));
      return;
    }
    // A module's name may hold `/`: its gitdir is nested that deep.
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  };
  if (await stat(modules).catch(() => undefined)) await visit(modules);
  return found;
}

/** `path` with every link in it resolved, the part below the deepest one that exists kept as is. */
async function realpathOf(path: string): Promise<string> {
  const real = await realpath(path).catch(() => undefined);
  if (real !== undefined) return real;
  const parent = dirname(path);
  return parent === path ? path : join(await realpathOf(parent), basename(path));
}
