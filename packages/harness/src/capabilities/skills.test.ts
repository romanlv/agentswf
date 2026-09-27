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
      expect(skillsLayout(harness, { home: "/box/homes/h", bundle: "/box/homes/h" })).toEqual({
        directory: "/box/homes/h/skills",
        home: "given",
      });
    }
  });

  test("on the host: claude's where --add-dir finds them, codex's in a home it needs", () => {
    expect(skillsLayout("claude", { bundle: "/run/b" })).toEqual({
      directory: "/run/b/.claude/skills",
      home: "none",
    });
    expect(skillsLayout("codex", { bundle: "/run/b" })).toEqual({
      directory: "/run/b/home/skills",
      home: "needed",
    });
    expect(skillsLayout("pi", { bundle: "/run/b" })).toEqual({
      directory: "/run/b/skills",
      home: "none",
    });
  });

  test("refuses a harness with no route", () => {
    expect(() => skillsLayout("cursor", { bundle: "/run/b" })).toThrow("refused");
  });
});

describe("skillsLaunch", () => {
  const skills = { directory: "/run/b/.claude/skills", names: ["alpha", "beta"] };

  test("claude on the host leaves the operator's settings out and adds the bundle", async () => {
    expect(await skillsLaunch("claude", skills, false, {})).toEqual({
      args: ["--setting-sources", "project,local", "--add-dir", "/run/b"],
      env: {},
    });
    expect(await skillsLaunch("claude", skills, true, {})).toEqual({ args: [], env: {} });
  });

  test("pi loads exactly the named directories", async () => {
    const given = { directory: "/run/b/skills", names: ["alpha", "beta"] };
    for (const sandboxed of [false, true]) {
      expect((await skillsLaunch("pi", given, sandboxed, {})).args).toEqual([
        "--no-skills",
        "--skill",
        "/run/b/skills/alpha",
        "--skill",
        "/run/b/skills/beta",
      ]);
    }
  });

  test("codex on the host: its own home, bundled off, and each operator skill off by real path", async () => {
    const home = join(root, "home");
    const store = join(root, "store", "tdd");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "SKILL.md"), "---\nname: tdd\n---\n");
    await mkdir(join(home, ".agents", "skills", "plain"), { recursive: true });
    await writeFile(join(home, ".agents", "skills", "plain", "SKILL.md"), "x");
    await mkdir(join(home, ".agents", "skills", "empty"));
    await symlink(store, join(home, ".agents", "skills", "tdd"));
    const given = { directory: "/run/b/home/skills", names: [], home: "/run/b/home" };
    const { args, env } = await skillsLaunch("codex", given, false, { HOME: home });
    expect(env).toEqual({ CODEX_HOME: "/run/b/home" });
    expect(args.slice(0, 2)).toEqual(["-c", "skills.bundled.enabled=false"]);
    expect(args[2]).toBe("-c");
    expect(args[3]).toBe(
      `skills.config=[{path=${JSON.stringify(join(home, ".agents/skills/plain/SKILL.md"))},enabled=false},` +
        `{path=${JSON.stringify(join(store, "SKILL.md"))},enabled=false}]`,
    );
  });

  test("codex in a sandbox only turns its bundled skills off, and on the host needs a home", async () => {
    const given = { directory: "/box/homes/h/skills", names: ["alpha"] };
    expect(await skillsLaunch("codex", given, true, {})).toEqual({
      args: ["-c", "skills.bundled.enabled=false"],
      env: {},
    });
    await expect(skillsLaunch("codex", given, false, {})).rejects.toThrow("home of its own");
  });
});
