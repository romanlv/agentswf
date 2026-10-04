import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsLaunch, skillsLayout } from "./skills";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "awf-caps-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("skillsLayout", () => {
  test("puts a sandboxed agent's skills in its home, for every harness", () => {
    for (const harness of ["claude", "codex", "pi"]) {
      expect(skillsLayout(harness, ["alpha"], { sandboxHome: "/box/homes/h" })).toEqual({
        names: ["alpha"],
        directory: "/box/homes/h/skills",
        sandboxed: true,
      });
    }
  });

  test("on the host: claude's where --add-dir finds them, codex's in a home of its own", () => {
    expect(skillsLayout("claude", [], { bundle: "/run/b", cwd: "/repo" })).toEqual({
      names: [],
      directory: "/run/b/.claude/skills",
      sandboxed: false,
    });
    expect(skillsLayout("codex", [], { bundle: "/run/b", cwd: "/repo" })).toEqual({
      names: [],
      directory: "/run/b/home/skills",
      ownHome: "/run/b/home",
      sandboxed: false,
    });
    expect(skillsLayout("pi", [], { bundle: "/run/b", cwd: "/repo" })).toEqual({
      names: [],
      directory: "/run/b/skills",
      sandboxed: false,
    });
  });

  test("refuses a host claude whose bundle is inside its working directory", () => {
    expect(() => skillsLayout("claude", [], { bundle: "/repo/runs/b", cwd: "/repo" })).toThrow(
      "inside its working directory",
    );
    expect(skillsLayout("codex", [], { bundle: "/repo/runs/b", cwd: "/repo" }).directory).toBe(
      "/repo/runs/b/home/skills",
    );
  });

  test("cursor only in a sandbox, under its own HOME's .cursor; and a harness awf does not know", () => {
    expect(() => skillsLayout("cursor", [], { bundle: "/run/b", cwd: "/repo" })).toThrow(
      "cursor cannot be given skills on the host",
    );
    expect(skillsLayout("cursor", ["alpha"], { sandboxHome: "/box/h" })).toEqual({
      names: ["alpha"],
      directory: "/box/h/.cursor/skills",
      sandboxed: true,
    });
    expect(() => skillsLayout("aider", [], { sandboxHome: "/box/h" })).toThrow("refused");
  });
});

describe("skillsLaunch", () => {
  test("claude on the host leaves the operator's settings out and adds the bundle", async () => {
    const host = skillsLayout("claude", ["alpha"], { bundle: "/run/b", cwd: "/repo" });
    expect(await skillsLaunch("claude", host, {})).toEqual({
      args: ["--setting-sources", "project,local", "--add-dir", "/run/b"],
      env: {},
    });
    const boxed = skillsLayout("claude", ["alpha"], { sandboxHome: "/box/h" });
    expect(await skillsLaunch("claude", boxed, {})).toEqual({ args: [], env: {} });
  });

  test("pi loads exactly the named directories, on the host and in a sandbox", async () => {
    for (const where of [{ bundle: "/run/b", cwd: "/repo" }, { sandboxHome: "/run/b" }]) {
      const given = skillsLayout("pi", ["alpha", "beta"], where);
      expect((await skillsLaunch("pi", given, {})).args).toEqual([
        "--no-skills",
        "--skill",
        "/run/b/skills/alpha",
        "--skill",
        "/run/b/skills/beta",
      ]);
    }
  });

  test("codex on the host: its own home, bundled off, and each shared skill off by real path", async () => {
    const home = join(root, "home");
    const store = join(root, "store", "tdd");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "SKILL.md"), "---\nname: tdd\n---\n");
    await mkdir(join(home, ".agents", "skills", "plain"), { recursive: true });
    await writeFile(join(home, ".agents", "skills", "plain", "SKILL.md"), "x");
    await mkdir(join(home, ".agents", "skills", "empty"));
    await symlink(store, join(home, ".agents", "skills", "tdd"));
    const given = skillsLayout("codex", [], { bundle: "/run/b", cwd: "/repo" });
    const { args, env } = await skillsLaunch("codex", given, { HOME: home });
    expect(env).toEqual({ CODEX_HOME: "/run/b/home" });
    expect(args).toEqual([
      "-c",
      "skills.bundled.enabled=false",
      "-c",
      `skills.config=[{path=${JSON.stringify(join(home, ".agents/skills/plain/SKILL.md"))},enabled=false},` +
        `{path=${JSON.stringify(join(store, "SKILL.md"))},enabled=false}]`,
    ]);
  });

  test("a path TOML would refuse raw is escaped", async () => {
    const home = join(root, 'we"ird\x7f');
    await mkdir(join(home, ".agents", "skills", "a"), { recursive: true });
    await writeFile(join(home, ".agents", "skills", "a", "SKILL.md"), "x");
    const given = skillsLayout("codex", [], { bundle: "/run/b", cwd: "/repo" });
    const { args } = await skillsLaunch("codex", given, { HOME: home });
    expect(args[3]).toContain('we\\"ird\\u007F');
    expect(args[3]).not.toContain("\x7f");
  });

  test("codex in a sandbox only turns its bundled skills off", async () => {
    const given = skillsLayout("codex", ["alpha"], { sandboxHome: "/box/h" });
    expect(await skillsLaunch("codex", given, {})).toEqual({
      args: ["-c", "skills.bundled.enabled=false"],
      env: {},
    });
  });
});
