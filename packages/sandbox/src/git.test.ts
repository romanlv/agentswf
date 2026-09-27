import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedPaths } from "./git";
import { resolveSandbox } from "./resolve";
import type { SandboxProvider, SandboxProviders } from "./seam";

const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-git-")));
const home = join(root, "home");
const main = join(home, "main");
const linked = join(home, "linked");
const runRoot = join(root, "runs");

const git = (cwd: string, ...args: string[]) => {
  const done = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
};

const provider: SandboxProvider<unknown> = {
  environment: () => ({}),
  open: () => Promise.reject(new Error("not opened here")),
};
const providers: SandboxProviders = { installed: { srt: provider }, default: "srt" };
const resolve = (cwd: string, spec: unknown) =>
  resolveSandbox(spec, { key: "box", cwd, runRoot, home, providers, harnessState: [] });

beforeAll(async () => {
  await mkdir(runRoot, { recursive: true });
  await mkdir(join(root, "library"), { recursive: true });
  git(join(root, "library"), "init", "-q");
  git(join(root, "library"), "commit", "-q", "--allow-empty", "-m", "one");
  await mkdir(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "one");
  git(main, "submodule", "add", "-q", join(root, "library"), "lib");
  git(main, "worktree", "add", "-q", linked);
  await mkdir(join(main, "vendor", "clone"), { recursive: true });
  git(join(main, "vendor", "clone"), "init", "-q");
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("what an agent may not write", () => {
  test("a linked worktree: its pointer, and the main worktree's index and HEAD", async () => {
    const { sandbox } = await resolve(linked, { write: ["."] });
    const common = join(main, ".git");
    expect(sandbox.gitdirs).toContainEqual({ path: common, writable: true, linked: true });
    const paths = await protectedPaths(sandbox);
    expect(paths).toEqual(
      expect.arrayContaining([
        join(linked, ".git"),
        join(common, "index"),
        join(common, "HEAD"),
        join(common, "worktrees", "linked", "config.worktree"),
        join(common, "hooks"),
        join(linked, ".claude", "settings.json"),
      ]),
    );
    // The main worktree is outside this reach: its own files are not guarded, nor mounted.
    expect(paths).not.toContain(join(main, ".mcp.json"));
  });

  test("the main worktree writable too: its index and HEAD are a commit's to write", async () => {
    const { sandbox } = await resolve(main, { write: [".", linked] });
    expect(sandbox.gitdirs).toContainEqual({ path: join(main, ".git"), writable: true });
    const paths = await protectedPaths(sandbox);
    expect(paths).not.toContain(join(main, ".git", "index"));
    expect(paths).not.toContain(join(main, ".git", "worktrees", "linked", "index"));
    expect(paths).toContain(join(linked, ".git"));
  });

  test("the main worktree alone: a linked one's index and HEAD are the operator's", async () => {
    const { sandbox } = await resolve(main, { write: ["."] });
    const paths = await protectedPaths(sandbox);
    expect(paths).toContain(join(main, ".git", "worktrees", "linked", "index"));
    expect(paths).toContain(join(main, ".git", "worktrees", "linked", "HEAD"));
    expect(paths).not.toContain(join(main, ".git", "index"));
    // A clone inside: its root's host-run config too.
    expect(paths).toContain(join(main, "vendor", "clone", ".mcp.json"));
  });

  test("a submodule's pointer, and a clone nested in a writable path", async () => {
    const { sandbox } = await resolve(main, { write: ["."] });
    const clone = join(main, "vendor", "clone", ".git");
    expect(sandbox.gitdirs).toContainEqual({ path: clone, writable: true });
    // Guarded whole in the superproject's: a submodule is not committed in, under any provider,
    // though an agent works in it.
    expect(sandbox.gitdirs).toContainEqual({
      path: join(main, ".git", "modules", "lib"),
      writable: false,
    });
    const inside = await resolve(join(main, "lib"), { write: [main] });
    expect(inside.sandbox.gitdirs).toContainEqual({
      path: join(main, ".git", "modules", "lib"),
      writable: false,
    });
    const paths = await protectedPaths(sandbox);
    expect(paths).toEqual(
      expect.arrayContaining([
        join(main, "lib", ".git"),
        join(main, ".git", "modules"),
        join(clone, "hooks"),
        join(clone, "config"),
        join(main, ".gitmodules"),
      ]),
    );
  });

  test("hooks `core.hooksPath` names, and what a protected link names, in a writable path", async () => {
    git(main, "config", "core.hooksPath", ".githooks");
    await mkdir(join(main, "config-shared"), { recursive: true });
    await symlink(join(main, "config-shared"), join(main, ".vscode"));
    // A link whose protected path under it does not exist yet: what it would name is guarded.
    await symlink(join(main, "config-shared"), join(main, ".claude"));
    try {
      const { sandbox } = await resolve(main, { write: ["."] });
      const paths = await protectedPaths(sandbox);
      expect(paths).toContain(join(main, ".githooks"));
      expect(paths).toContain(join(main, ".vscode"));
      expect(paths).toContain(join(main, "config-shared"));
      expect(paths).toContain(join(main, "config-shared", "settings.json"));
      // From a linked worktree, whose own root the relative path is taken against.
      const fromLinked = await protectedPaths((await resolve(linked, { write: ["."] })).sandbox);
      expect(fromLinked).toContain(join(linked, ".githooks"));
    } finally {
      git(main, "config", "--unset", "core.hooksPath");
      await rm(join(main, ".vscode"));
      await rm(join(main, ".claude"));
      await rm(join(main, "config-shared"), { recursive: true });
    }
  });

  test("a repository in a writable path whose gitdir lies outside it is refused", async () => {
    const planted = join(main, "planted");
    await mkdir(planted, { recursive: true });
    await writeFile(join(planted, ".git"), `gitdir: ${join(root, "library", ".git")}\n`);
    try {
      await expect(resolve(main, { write: ["."] })).rejects.toThrow(
        `whose gitdir ${join(root, "library", ".git")} is outside it`,
      );
    } finally {
      await rm(planted, { recursive: true });
    }
  });

  test("a worktree whose gitdir was pruned is refused, saying so", async () => {
    const gone = join(home, "gone");
    await mkdir(gone, { recursive: true });
    await writeFile(join(gone, ".git"), `gitdir: ${join(root, "nowhere")}\n`);
    await expect(resolve(gone, {})).rejects.toThrow("which is gone: git worktree prune");
  });
});
