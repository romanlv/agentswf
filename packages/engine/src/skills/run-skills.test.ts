import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSkillFile, placeSkill, RunSkills, readSkillSources } from "./run-skills";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "awf-skills-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const skillFile = (name: string, body = "Say the word.") =>
  `---\nname: ${name}\ndescription: Use when asked for the word.\n---\n${body}\n`;

async function skillAt(directory: string, name: string, body?: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), skillFile(name, body));
  return directory;
}

function runSkills() {
  return new RunSkills({ runDir: join(root, "run"), cacheRoot: join(root, "cache") });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
}

/** A repository with two skills, served over `file://` as a public one would be over https. */
async function repository(): Promise<{ url: string; first: string; work: string }> {
  const work = join(root, "upstream");
  await skillAt(join(work, "skills", "alpha"), "alpha", "Alpha one.");
  await skillAt(join(work, "skills", "beta"), "beta");
  await writeFile(join(work, "skills", "alpha", "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(work, "skills", "alpha", "run.sh"), 0o755);
  await git(root, "init", "--quiet", "--initial-branch=main", work);
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "first");
  const first = await git(work, "rev-parse", "HEAD");
  return { url: pathToFileURL(work).href, first, work };
}

describe("readSkillSources", () => {
  test("takes a path, a file: URL and a public skill", () => {
    const url = pathToFileURL("/tmp/skills/a");
    expect(
      readSkillSources([
        { path: "/tmp/skills/a" },
        { path: url },
        { path: url.href },
        { repo: "owner/repo", skill: "a", ref: "v1" },
      ]),
    ).toEqual([
      { path: "/tmp/skills/a" },
      { path: "/tmp/skills/a" },
      { path: "/tmp/skills/a" },
      { repo: "owner/repo", skill: "a", ref: "v1" },
    ]);
  });

  test("refuses a bare name, a relative path, and what is neither source", () => {
    expect(() => readSkillSources(["tdd"])).toThrow("name a source");
    expect(() => readSkillSources([{ path: "./skills/a" }])).toThrow("import.meta.url");
    expect(() => readSkillSources([{ path: new URL("https://example.com/a") }])).toThrow(
      "not a file: URL",
    );
    expect(() => readSkillSources([{ repo: "just-a-name", skill: "a" }])).toThrow("git URL");
    expect(() => readSkillSources([{ repo: "o/r", skill: "a", ref: "" }])).toThrow("ref");
    expect(() => readSkillSources([{ path: "/a", repo: "o/r", skill: "a" }])).toThrow(
      "not a skill source",
    );
    expect(() => readSkillSources("a")).toThrow("an array");
  });
});

describe("parseSkillFile", () => {
  test("reads the name and description", () => {
    expect(parseSkillFile(skillFile("my-skill"), "x")).toEqual({
      name: "my-skill",
      description: "Use when asked for the word.",
    });
  });

  test("refuses a name no harness takes, a missing description and no frontmatter", () => {
    expect(() => parseSkillFile(skillFile("My Skill"), "x")).toThrow("lowercase");
    expect(() => parseSkillFile(skillFile("../up"), "x")).toThrow("lowercase");
    expect(() => parseSkillFile("---\nname: a\n---\nbody\n", "x")).toThrow("no description");
    expect(() => parseSkillFile("# a skill\n", "x")).toThrow("no frontmatter");
  });
});

describe("a path source", () => {
  test("is snapshotted once per run, and a copy does not follow its source", async () => {
    const source = await skillAt(join(root, "mine", "word"), "word", "The word is ONE.");
    const skills = runSkills();
    const [first] = await skills.resolve([{ path: source }]);
    await writeFile(join(source, "SKILL.md"), skillFile("word", "The word is TWO."));
    const [again] = await skills.resolve([{ path: source }]);
    expect(again!.snapshot).toBe(first!.snapshot);
    await placeSkill(again!, join(root, "agent"));
    expect(await readFile(join(root, "agent", "word", "SKILL.md"), "utf8")).toContain("ONE");
    expect(first!.record).toEqual({
      name: "word",
      source: { path: source },
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  test("is copied under its SKILL.md name, not its directory's", async () => {
    const source = await skillAt(join(root, "somewhere"), "named");
    const [skill] = await runSkills().resolve([{ path: source }]);
    await placeSkill(skill!, join(root, "agent"));
    expect((await stat(join(root, "agent", "named", "SKILL.md"))).isFile()).toBe(true);
  });

  test("refuses a link, which would carry what it points at", async () => {
    const source = await skillAt(join(root, "linky"), "linky");
    await symlink(join(root, "secret"), join(source, "key"));
    await expect(runSkills().resolve([{ path: source }])).rejects.toThrow("is a link");
  });

  test("refuses a missing directory, a missing SKILL.md, and two skills of one name", async () => {
    const skills = runSkills();
    await expect(skills.resolve([{ path: join(root, "nowhere") }])).rejects.toThrow(
      "does not exist",
    );
    await mkdir(join(root, "empty"));
    await expect(skills.resolve([{ path: join(root, "empty") }])).rejects.toThrow("no SKILL.md");
    const a = await skillAt(join(root, "a"), "same");
    const b = await skillAt(join(root, "b"), "same");
    await expect(skills.resolve([{ path: a }, { path: b }])).rejects.toThrow(
      "two skills are named same",
    );
  });

  test("refuses a tree over the size cap", async () => {
    const source = await skillAt(join(root, "big"), "big");
    await writeFile(join(source, "blob"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(runSkills().resolve([{ path: source }])).rejects.toThrow("bytes");
  });

  test("keeps a script executable, and equal trees have equal digests", async () => {
    const source = await skillAt(join(root, "exec"), "exec");
    await writeFile(join(source, "run.sh"), "#!/bin/sh\n");
    await chmod(join(source, "run.sh"), 0o755);
    const [skill] = await runSkills().resolve([{ path: source }]);
    const [other] = await new RunSkills({ runDir: join(root, "run2") }).resolve([{ path: source }]);
    expect(other!.record.digest).toBe(skill!.record.digest);
    await placeSkill(skill!, join(root, "agent"));
    expect((await stat(join(root, "agent", "exec", "run.sh"))).mode & 0o111).not.toBe(0);
  });
});

describe("a repo source", () => {
  test("resolves the default branch to a commit, and finds the skill by its name", async () => {
    const { url, first } = await repository();
    const [skill] = await runSkills().resolve([{ repo: url, skill: "alpha" }]);
    expect(skill!.record).toEqual({
      name: "alpha",
      source: { repo: url, skill: "alpha" },
      commit: first,
      within: "skills/alpha",
      digest: expect.stringMatching(/^sha256:/),
    });
    await placeSkill(skill!, join(root, "agent"));
    expect(await readFile(join(root, "agent", "alpha", "SKILL.md"), "utf8")).toContain("Alpha one");
    expect((await stat(join(root, "agent", "alpha", "run.sh"))).mode & 0o111).not.toBe(0);
  });

  test("pins a branch, a tag and a commit", async () => {
    const { url, first, work } = await repository();
    await git(work, "tag", "v1");
    await writeFile(join(work, "skills", "alpha", "SKILL.md"), skillFile("alpha", "Alpha two."));
    await git(work, "commit", "--quiet", "-am", "second");
    const second = await git(work, "rev-parse", "HEAD");
    const skills = runSkills();
    const [branch, tag, commit, short] = await Promise.all([
      skills.resolve([{ repo: url, skill: "alpha", ref: "main" }]),
      skills.resolve([{ repo: url, skill: "alpha", ref: "v1" }]),
      skills.resolve([{ repo: url, skill: "alpha", ref: first }]),
      skills.resolve([{ repo: url, skill: "alpha", ref: first.slice(0, 10) }]),
    ]);
    expect(branch[0]!.record.commit).toBe(second);
    expect(tag[0]!.record.commit).toBe(first);
    expect(commit[0]!.record.commit).toBe(first);
    expect(short[0]!.record.commit).toBe(first);
    expect(await readFile(join(tag[0]!.snapshot, "SKILL.md"), "utf8")).toContain("Alpha one");
  });

  test("names the skills it has when the one asked for is not there", async () => {
    const { url } = await repository();
    await expect(runSkills().resolve([{ repo: url, skill: "gamma" }])).rejects.toThrow(
      "it has alpha, beta",
    );
  });

  test("refuses a ref it cannot find, and a link in the skill", async () => {
    const { url, work } = await repository();
    const skills = runSkills();
    await expect(skills.resolve([{ repo: url, skill: "alpha", ref: "nope" }])).rejects.toThrow(
      "cannot fetch nope",
    );
    await expect(
      skills.resolve([{ repo: url, skill: "alpha", ref: "0000000000" }]),
    ).rejects.toThrow("no commit 0000000000");
    await symlink("/etc/hosts", join(work, "skills", "beta", "hosts"));
    await git(work, "add", ".");
    await git(work, "commit", "--quiet", "-m", "link");
    await expect(skills.resolve([{ repo: url, skill: "beta" }])).rejects.toThrow("is a link");
  });

  test("a second run fetches into the same cache", async () => {
    const { url, first } = await repository();
    await runSkills().resolve([{ repo: url, skill: "beta" }]);
    const [again] = await new RunSkills({
      runDir: join(root, "run2"),
      cacheRoot: join(root, "cache"),
    }).resolve([{ repo: url, skill: "beta" }]);
    expect(again!.record.commit).toBe(first);
  });
});

describe("the record", () => {
  test("says operator for an agent left to the operator's skills", async () => {
    const skills = runSkills();
    const source = await skillAt(join(root, "w"), "w");
    skills.record("a", "operator");
    skills.record("b", await skills.resolve([{ path: source }]));
    skills.record("c", []);
    expect(skills.records()).toEqual([
      { callPath: [], agent: "a", skills: "operator" },
      {
        callPath: [],
        agent: "b",
        skills: [{ name: "w", source: { path: source }, digest: expect.any(String) }],
      },
      { callPath: [], agent: "c", skills: [] },
    ]);
  });
});
