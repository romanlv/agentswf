import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDomain, repositoryOf, resolveSandbox, withinReach } from "./resolve";
import type { SandboxProvider, SandboxProviders } from "./seam";

// Made before the tests are declared, which `test.each` does with these paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-resolve-")));
const home = join(root, "home");
const runRoot = join(root, "runs");
const repo = join(home, "repo");

const provider = (name: string): SandboxProvider<unknown> => ({
  environment: (raw) => ({ name, raw }),
  open: () => Promise.reject(new Error("not opened here")),
});
const providers: SandboxProviders = {
  installed: { srt: provider("srt"), docker: provider("docker") },
  default: "srt",
};
const harnessState = [join(home, ".claude"), join(home, ".codex"), join(home, ".pi", "agent")];
const resolve = (
  spec: unknown,
  extra: { inline?: boolean; providers?: SandboxProviders; runRoot?: string } = {},
) =>
  resolveSandbox(spec, { key: "box", cwd: repo, runRoot, home, providers, harnessState, ...extra });

beforeAll(async () => {
  await mkdir(join(repo, ".git", "worktrees", "feature"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(home, "notes"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, ".awf", "sandboxes"), { recursive: true });
  await mkdir(join(home, ".orbstack", "ssh"), { recursive: true });
  await mkdir(join(home, "feature"), { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(home, "feature", ".git"), "gitdir: ../repo/.git/worktrees/feature\n");
  await writeFile(join(repo, ".git", "worktrees", "feature", "commondir"), "../..\n");
  // Crafted `.git` files, as a replayed repository could carry.
  for (const [name, target] of [
    ["points-home", home],
    ["points-runs", runRoot],
    ["points-root", join(repo, ".git", "worktrees", "rooted")],
  ] as const) {
    await mkdir(join(root, "crafted", name), { recursive: true });
    await writeFile(join(root, "crafted", name, ".git"), `gitdir: ${target}\n`);
  }
  await mkdir(join(repo, ".git", "worktrees", "rooted"), { recursive: true });
  await writeFile(
    join(repo, ".git", "worktrees", "rooted", "commondir"),
    "../../../../../../../../..\n",
  );
  await mkdir(join(runRoot, "a-run"), { recursive: true });
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  // A dotfiles repository at `~`, and a directory under it that belongs to no other repository.
  await mkdir(join(home, ".git"), { recursive: true });
  await mkdir(join(home, "scratch"), { recursive: true });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("resolveSandbox", () => {
  test("resolves ~, relative paths and the working directory's gitdir", async () => {
    const { provider, sandbox } = await resolve({
      key: "ignored-by-resolution",
      cwd: "src",
      read: ["~/notes", ".."],
      write: ["."],
      network: ["Registry.npmjs.org", "*.npmjs.org"],
    });
    expect(provider).toBe("srt");
    expect(sandbox).toEqual({
      key: "box",
      cwd: join(repo, "src"),
      read: [join(home, "notes"), repo],
      write: [join(repo, "src")],
      network: ["registry.npmjs.org", "*.npmjs.org"],
      // Read-only: `src` is writable, not the worktree whose history it holds.
      gitdirs: [{ path: join(repo, ".git"), writable: false }],
      environment: { name: "srt", raw: {} },
    });
  });

  test("a path in both lists is writable only", async () => {
    const { sandbox } = await resolve({ read: [".", "~/notes"], write: ["."] });
    expect(sandbox.read).toEqual([join(home, "notes")]);
    expect(sandbox.write).toEqual([repo]);
  });

  test("names the provider by its environment key, and hands it the settings", async () => {
    const { provider, sandbox } = await resolve({ docker: { image: "node:22" } });
    expect(provider).toBe("docker");
    expect(sandbox.environment).toEqual({ name: "docker", raw: { image: "node:22" } });
  });

  test("a worktree brings its gitdir and the common one", async () => {
    expect(await repositoryOf(join(home, "feature"), home)).toEqual({
      root: join(home, "feature"),
      gitdirs: [join(repo, ".git", "worktrees", "feature"), join(repo, ".git")],
    });
    const { sandbox } = await resolve({ cwd: join(home, "feature") });
    expect(sandbox.gitdirs).toEqual([
      { path: join(repo, ".git", "worktrees", "feature"), writable: false },
      { path: join(repo, ".git"), writable: false },
    ]);
    // A writable worktree commits: both its gitdir and the common one take its writes.
    const { sandbox: writable } = await resolve({ cwd: join(home, "feature"), write: ["."] });
    expect(writable.gitdirs.map((gitdir) => gitdir.writable)).toEqual([true, true]);
    expect(await repositoryOf(join(home, "notes"), home)).toBeUndefined();
    // Found by walking up, as git does, but never at `~` itself.
    expect(await repositoryOf(join(repo, "src"), home)).toEqual({
      root: repo,
      gitdirs: [join(repo, ".git")],
    });
    const { sandbox: scratch } = await resolve({ cwd: "~/scratch" });
    expect(scratch.gitdirs).toEqual([]);
  });

  test("a gitdir is writable only where its whole worktree is, the most specific path winning", async () => {
    const writable = async (spec: object) =>
      (await resolve(spec)).sandbox.gitdirs.map((gitdir) => gitdir.writable);
    expect(await writable({ write: ["."] })).toEqual([true]);
    expect(await writable({ write: ["src"] })).toEqual([false]);
    expect(await writable({ write: ["."], read: ["src"] })).toEqual([true]);
    // `read` nested in `write` is read-only; the worktree root is still covered by `write`.
    expect(await writable({ cwd: "src", write: [".."], read: ["."] })).toEqual([true]);
    expect(await writable({ read: ["."] })).toEqual([false]);
    // A working directory inside a writable worktree does not make it read-only.
    expect(await writable({ cwd: "src", write: [".."] })).toEqual([true]);
  });

  test("a run root inside the repository leaves its gitdir found", async () => {
    const inside = join(repo, "runs");
    await mkdir(inside, { recursive: true });
    const { sandbox } = await resolveSandbox(
      { cwd: "src" },
      { key: "box", cwd: repo, runRoot: inside, home, providers, harnessState },
    );
    expect(sandbox.gitdirs).toEqual([{ path: join(repo, ".git"), writable: false }]);
  });

  test("the engine's doors are refused: their root, and a run's directory under it", async () => {
    const doors = join(root, "doors");
    await mkdir(join(doors, "awf-run", "a1"), { recursive: true });
    await mkdir(join(doors, "mine"), { recursive: true });
    const options = {
      key: "box",
      cwd: repo,
      runRoot,
      home,
      providers,
      harnessState,
      controlRoot: doors,
    };
    for (const path of [doors, join(doors, "awf-run"), join(doors, "awf-run", "a1")]) {
      await expect(resolveSandbox({ write: [path] }, options)).rejects.toThrow(
        "would expose the engine's doors",
      );
    }
    const { sandbox } = await resolveSandbox({ write: [join(doors, "mine")] }, options);
    expect(sandbox.write).toEqual([join(doors, "mine")]);
  });

  test("harness state the operator moved is refused too", async () => {
    await expect(
      resolveSandbox(
        { read: ["~/notes"] },
        { key: "box", cwd: repo, runRoot, home, providers, harnessState: [join(home, "notes")] },
      ),
    ).rejects.toThrow("would expose harness state");
  });

  test("an agent is within reach under the working directory or a reach path", async () => {
    const { sandbox } = await resolve({ cwd: "src", read: ["~/notes"] });
    expect(withinReach(sandbox, join(repo, "src", "deep"))).toBe(true);
    expect(withinReach(sandbox, join(home, "notes"))).toBe(true);
    expect(withinReach(sandbox, repo)).toBe(false);
    expect(withinReach(sandbox, join(repo, "srcs"))).toBe(false);
  });

  test.each([
    [{ read: [""] }, "non-empty path"],
    [{ write: [7] }, "non-empty path"],
    [{ read: ["missing"] }, "missing does not exist"],
    [{ read: "~/notes" }, "must be a list"],
    [{ read: ["~"] }, "would expose ~"],
    [{ read: [root] }, "would expose ~"],
    [{ read: [runRoot] }, "would expose the run root"],
    [{ read: [join(runRoot, "..")] }, "would expose"],
    [{ read: [join(runRoot, "a-run")] }, "would expose the run root"],
    [{ read: ["~/.claude/projects"] }, "would expose harness state"],
    [{ read: ["~/.claude"] }, "would expose harness state"],
    [{ read: ["~/.ssh"] }, "would expose keys"],
    [{ read: ["~/.awf"] }, "would expose"],
    [{ write: ["~/.awf/sandboxes"] }, "would expose"],
    [{ docker: {}, read: ["~/.orbstack"] }, "would expose keys"],
    [{ read: ["~root"] }, "only ~ and ~/ expand"],
    [{ cwd: join(root, "crafted", "points-home") }, "would expose ~"],
    [{ read: [join(root, "crafted", "points-runs")] }, "would expose the run root"],
    [{ cwd: join(root, "crafted", "points-root") }, "gitdir of"],
    [{ network: ["*.com"] }, "not a sandbox domain"],
    [{ network: ["0x7f000001"] }, "not a sandbox domain"],
    [{ srt: {}, docker: {} }, "one environment, not srt and docker"],
    [{ vm: {} }, 'unknown sandbox field "vm"'],
    [{ network: ["https://x.org"] }, "not a sandbox domain"],
    [{ network: ["1.2.3.4"] }, "not a sandbox domain"],
    [{ network: ["x.org:443"] }, "not a sandbox domain"],
    [{ network: ["*"] }, "not a sandbox domain"],
    [null, "must be an object"],
  ])("rejects %j", async (spec, reason) => {
    await expect(resolve(spec)).rejects.toThrow(reason);
  });

  test("a project holding the run root resolves, and its runs are still refused", async () => {
    const projectRuns = join(repo, ".awf", "runs");
    await mkdir(join(projectRuns, "flow", "r1"), { recursive: true });
    const { sandbox } = await resolve({ write: ["."] }, { runRoot: projectRuns });
    expect(sandbox.write).toEqual([repo]);
    await expect(
      resolve({ read: [join(projectRuns, "flow", "r1")] }, { runRoot: projectRuns }),
    ).rejects.toThrow("would expose the run root");
  });

  test("tells `{ srt: undefined }` from an environment", async () => {
    const { provider } = await resolve({ srt: undefined, docker: {} });
    expect(provider).toBe("docker");
  });

  test("an inline spec cannot carry an open spec's or a ref's fields", async () => {
    for (const field of ["key", "cwd", "provider"]) {
      await expect(resolve({ [field]: "x" }, { inline: true })).rejects.toThrow(
        `inline sandbox cannot name ${field}`,
      );
    }
  });

  test("refuses a provider that is not installed, or none at all", async () => {
    const only = { installed: { srt: provider("srt") } };
    await expect(resolve({ docker: {} }, { providers: only })).rejects.toThrow(
      "the docker sandbox provider is not installed",
    );
    await expect(resolve({}, { providers: only })).rejects.toThrow("no sandbox provider");
  });

  test("a provider's own check of its settings rejects", async () => {
    const strict: SandboxProviders = {
      installed: {
        srt: {
          environment: () => {
            throw new Error("srt takes no settings");
          },
          open: () => Promise.reject(new Error("unused")),
        },
      },
    };
    await expect(resolve({ srt: { x: 1 } }, { providers: strict })).rejects.toThrow(
      "srt takes no settings",
    );
  });
});

test("isDomain", () => {
  for (const good of ["api.anthropic.com", "*.chatgpt.com", "localhost", "a-b.c0.io"]) {
    expect(isDomain(good)).toBe(true);
  }
  for (const bad of [
    "",
    "*.",
    "-a.com",
    "a..com",
    "*.*.com",
    "*.com",
    "a.com/x",
    "a.com.",
    "10.0.0.1",
    "0x7f000001",
    "::1",
    `${"a".repeat(64)}.com`,
  ]) {
    expect(isDomain(bad)).toBe(false);
  }
});
