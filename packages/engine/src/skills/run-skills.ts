import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSkillsRecord, SkillRecord } from "@wf/contract/records";

type Environment = Readonly<Record<string, string | undefined>>;

/** A source as the workflow named it, checked and made absolute. */
export type SkillSource = { path: string } | { repo: string; skill: string; ref?: string };

/** A skill resolved for this run: a checked snapshot every agent naming it is copied from. */
export type ResolvedSkill = {
  name: string;
  /** The run's snapshot, which no agent reaches. */
  snapshot: string;
  record: SkillRecord;
};

/** Refused: past these, a skill is not instructions and a few scripts. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 2_000;
/** The name becomes a directory; claude's rule, which every harness accepts. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A workflow is untyped JavaScript at run time: each source is checked, and a relative path refused. */
export function readSkillSources(skills: unknown): SkillSource[] {
  if (!Array.isArray(skills)) throw new Error("skills must be an array of skill sources");
  return skills.map((skill): SkillSource => {
    if (typeof skill === "string") {
      throw new Error(
        `skill ${JSON.stringify(skill)}: name a source, { path } or { repo, skill, ref? }`,
      );
    }
    const source = skill as Record<string, unknown> | null;
    if (source && "path" in source && !("repo" in source) && !("skill" in source)) {
      return { path: absoluteSkillPath(source.path) };
    }
    if (
      source &&
      typeof source.repo === "string" &&
      typeof source.skill === "string" &&
      !("path" in source)
    ) {
      if (source.ref !== undefined && (typeof source.ref !== "string" || source.ref === "")) {
        throw new Error(`skill ${source.skill}: ref must be a non-empty string`);
      }
      repositoryUrl(source.repo);
      return {
        repo: source.repo,
        skill: source.skill,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
      };
    }
    throw new Error(
      `not a skill source: ${JSON.stringify(skill)}; use { path } or { repo, skill }`,
    );
  });
}

function absoluteSkillPath(path: unknown): string {
  if (path instanceof URL) {
    if (path.protocol !== "file:") throw new Error(`skill path ${path.href} is not a file: URL`);
    return fileURLToPath(path);
  }
  if (typeof path !== "string" || path === "") throw new Error("a skill path must be a string");
  if (path.startsWith("file:")) return fileURLToPath(path);
  if (!isAbsolute(path)) {
    // Relative to what would differ between a workflow and the one that calls it.
    throw new Error(
      `skill path ${path} is relative; use an absolute path, or new URL("${path}", import.meta.url)`,
    );
  }
  return path;
}

/** `owner/repo` is GitHub's; anything else must already be a URL git fetches. */
function repositoryUrl(repo: string): string {
  if (GITHUB_SHORTHAND.test(repo)) return `https://github.com/${repo}.git`;
  if (/^(?:https?|ssh|git|file):\/\//.test(repo) || /^[\w.-]+@[\w.-]+:/.test(repo)) return repo;
  throw new Error(`skill repo ${repo} is neither owner/repo nor a git URL`);
}

/**
 * A run's skills: each source resolved once, so every agent naming it gets the same files, into a
 * snapshot under the run directory; then a copy per agent, and the record of what each agent had.
 */
export class RunSkills {
  readonly #resolved = new Map<string, Promise<ResolvedSkill>>();
  /** Each repository's last fetch in line: git's shallow lock refuses a second one at once. */
  readonly #fetching = new Map<string, Promise<unknown>>();
  readonly #records: AgentSkillsRecord[] = [];
  readonly #root: string;
  readonly #cache: string;
  readonly #environment: Environment;

  constructor(options: { runDir: string; cacheRoot?: string; environment?: Environment }) {
    this.#environment = options.environment ?? process.env;
    this.#root = join(options.runDir, "skills");
    this.#cache = options.cacheRoot ?? defaultCacheRoot(this.#environment);
  }

  /** Every source resolved and checked, or the first reason one could not be. */
  async resolve(sources: readonly SkillSource[]): Promise<ResolvedSkill[]> {
    const resolved = await Promise.all(sources.map((source) => this.#one(source)));
    const seen = new Set<string>();
    for (const { name } of resolved) {
      if (seen.has(name)) throw new Error(`two skills are named ${name}`);
      seen.add(name);
    }
    return resolved;
  }

  /** What an agent was given: `operator` when the workflow left its skills out. */
  record(agent: string, skills: "operator" | readonly ResolvedSkill[]): void {
    this.#records.push({
      callPath: [],
      agent,
      skills: skills === "operator" ? "operator" : skills.map((skill) => ({ ...skill.record })),
    });
  }

  records(): AgentSkillsRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }

  #one(source: SkillSource): Promise<ResolvedSkill> {
    const key = JSON.stringify(source);
    let resolving = this.#resolved.get(key);
    if (!resolving) {
      resolving = "path" in source ? this.#fromPath(source) : this.#fromRepo(source);
      this.#resolved.set(key, resolving);
      // A source that failed is tried again by the next agent that names it, not remembered.
      resolving.catch(() => {
        if (this.#resolved.get(key) === resolving) this.#resolved.delete(key);
      });
    }
    return resolving;
  }

  async #fromPath(source: { path: string }): Promise<ResolvedSkill> {
    let directory: string;
    try {
      directory = await realpath(source.path);
    } catch {
      throw new Error(`skill path ${source.path} does not exist`);
    }
    const snapshot = await this.#snapshot((into) => copySkillTree(directory, into));
    const { name, digest } = await checkSkill(snapshot, source.path);
    return { name, snapshot, record: { name, source: { path: source.path }, digest } };
  }

  async #fromRepo(source: { repo: string; skill: string; ref?: string }): Promise<ResolvedSkill> {
    const url = repositoryUrl(source.repo);
    const repository = await this.#repository(url);
    const previous = this.#fetching.get(repository) ?? Promise.resolve();
    const fetching = previous.then(
      () => fetchCommit(repository, url, source.ref, this.#environment),
      () => fetchCommit(repository, url, source.ref, this.#environment),
    );
    this.#fetching.set(
      repository,
      fetching.catch(() => undefined),
    );
    const commit = await fetching;
    const within = await findSkill(repository, commit, source.skill, this.#environment);
    const snapshot = await this.#snapshot((into) =>
      extract(repository, commit, within, into, this.#environment),
    );
    const label = `${source.repo}@${source.skill}`;
    const { name, digest } = await checkSkill(snapshot, label);
    if (name !== source.skill) throw new Error(`${label}: its SKILL.md is named ${name}`);
    return {
      name,
      snapshot,
      record: {
        name,
        source: { ...source },
        commit,
        ...(within === "" ? {} : { within }),
        digest,
      },
    };
  }

  /** A bare repository per URL, shared by every run: git locks its own refs and objects. */
  async #repository(url: string): Promise<string> {
    const directory = join(
      this.#cache,
      "repos",
      createHash("sha256").update(url).digest("hex").slice(0, 24),
    );
    if (!(await exists(join(directory, "HEAD")))) {
      await mkdir(join(this.#cache, "repos"), { recursive: true });
      const staged = `${directory}.${randomUUID()}`;
      await git(["init", "--quiet", "--bare", staged], this.#environment);
      // Two runs may create it at once; the one that lands second keeps the first's.
      await rename(staged, directory).catch(() => rm(staged, { recursive: true, force: true }));
    }
    return directory;
  }

  /** A fresh directory under the run's, filled by `fill` before it is used. */
  async #snapshot(fill: (into: string) => Promise<void>): Promise<string> {
    const snapshot = join(this.#root, "sources", randomUUID());
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    await fill(snapshot);
    return snapshot;
  }
}

/** Copies `skill` into `directory/{name}`; the directory must not already hold one. */
export async function placeSkill(skill: ResolvedSkill, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await copySkillTree(skill.snapshot, join(directory, skill.name));
}

function defaultCacheRoot(environment: Environment): string {
  const cache = environment.XDG_CACHE_HOME || join(environment.HOME ?? homedir(), ".cache");
  return join(cache, "awf", "skills");
}

/**
 * The name and digest of a checked snapshot: a `SKILL.md` with a `name` and a `description`, and
 * nothing a copy could carry out of it.
 */
async function checkSkill(
  snapshot: string,
  label: string,
): Promise<{ name: string; digest: string }> {
  let text: string;
  try {
    text = await readFile(join(snapshot, "SKILL.md"), "utf8");
  } catch {
    throw new Error(`skill ${label} has no SKILL.md`);
  }
  const { name } = parseSkillFile(text, label);
  return { name, digest: await digestTree(snapshot) };
}

/** The frontmatter every harness reads: a `name` it can be a directory by, and a `description`. */
export function parseSkillFile(text: string, label: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`skill ${label}: SKILL.md has no frontmatter`);
  let front: unknown;
  try {
    front = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new Error(`skill ${label}: SKILL.md frontmatter is not YAML: ${String(error)}`);
  }
  const { name, description } = (front ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || !SKILL_NAME.test(name) || name.length > 64) {
    throw new Error(
      `skill ${label}: its name must be lowercase letters, digits and hyphens, at most 64`,
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`skill ${label}: SKILL.md has no description`);
  }
  return { name, description };
}

/**
 * A skill's files, copied: never a link, which could carry what it points at, `~/.ssh` say, into
 * a sandbox, nor anything but files and directories, and within the size caps.
 */
async function copySkillTree(from: string, to: string): Promise<void> {
  const budget = { bytes: 0, files: 0 };
  await mkdir(to, { recursive: true, mode: 0o755 });
  const walk = async (at: string) => {
    for (const entry of await readdir(join(from, at))) {
      const path = join(at, entry);
      const found = await lstat(join(from, path));
      if (found.isSymbolicLink()) throw new Error(`skill ${from}: ${path} is a link`);
      if (found.isDirectory()) {
        await mkdir(join(to, path), { mode: 0o755 });
        await walk(path);
        continue;
      }
      if (!found.isFile()) throw new Error(`skill ${from}: ${path} is not a file`);
      budget.bytes += found.size;
      budget.files += 1;
      if (budget.bytes > MAX_BYTES || budget.files > MAX_FILES) {
        throw new Error(`skill ${from} is over ${MAX_FILES} files or ${MAX_BYTES} bytes`);
      }
      await writeFile(join(to, path), await readFile(join(from, path)), {
        mode: found.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  };
  await walk("");
}

/** Over each file's path, executable bit and bytes, sorted: equal digests, equal skills. */
async function digestTree(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(join(root, at))) {
      const path = join(at, entry);
      const found = await lstat(join(root, path));
      if (found.isDirectory()) {
        await walk(path);
        continue;
      }
      const bytes = await readFile(join(root, path));
      const hash = createHash("sha256").update(bytes).digest("hex");
      lines.push(`${path}\0${found.mode & 0o111 ? "x" : "-"}\0${hash}\n`);
    }
  };
  await walk("");
  const digest = createHash("sha256");
  for (const line of lines.sort()) digest.update(line);
  return `sha256:${digest.digest("hex")}`;
}

/** The commit `ref` names, or the default branch's, fetched into `repository`. */
async function fetchCommit(
  repository: string,
  url: string,
  ref: string | undefined,
  environment: Environment,
): Promise<string> {
  // A ref of our own per fetch: two agents or runs fetching at once never read each other's.
  const into = `refs/awf/${randomUUID()}`;
  try {
    const shallow = await unlocked(() =>
      git(
        ["-C", repository, "fetch", "--quiet", "--depth", "1", url, `+${ref ?? "HEAD"}:${into}`],
        environment,
        { allowFailure: true },
      ),
    );
    if (shallow.ok) return (await git(["-C", repository, "rev-parse", into], environment)).out;
    if (ref === undefined || !/^[0-9a-f]{7,40}$/i.test(ref)) {
      throw new Error(`cannot fetch ${ref ?? "the default branch"} of ${url}: ${shallow.err}`);
    }
    // A commit, which a server need not serve by itself: every branch and tag, then the commit.
    const full = await unlocked(() =>
      git(
        [
          "-C",
          repository,
          "fetch",
          "--quiet",
          url,
          `+refs/heads/*:${into}/heads/*`,
          `+refs/tags/*:${into}/tags/*`,
        ],
        environment,
        { allowFailure: true },
      ),
    );
    if (!full.ok) throw new Error(`cannot fetch ${url}: ${full.err}`);
    const found = await git(
      ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`],
      environment,
      {
        allowFailure: true,
      },
    );
    if (!found.ok) throw new Error(`${url} has no commit ${ref}`);
    return found.out;
  } finally {
    const refs = await git(
      ["-C", repository, "for-each-ref", "--format=%(refname)", into],
      environment,
      {
        allowFailure: true,
      },
    );
    for (const name of [into, ...refs.out.split("\n").filter(Boolean)]) {
      await git(["-C", repository, "update-ref", "-d", name], environment, { allowFailure: true });
    }
  }
}

/**
 * `fetch`, again while another run's fetch into the shared cache holds one of git's locks: it
 * refuses rather than waits, and the other is done in well under the ten seconds allowed here.
 */
async function unlocked(
  fetch: () => Promise<{ ok: boolean; out: string; err: string }>,
): Promise<{ ok: boolean; out: string; err: string }> {
  for (let attempt = 0; ; attempt++) {
    const result = await fetch();
    if (result.ok || !/\.lock'?: File exists/.test(result.err) || attempt >= 40) return result;
    await Bun.sleep(250);
  }
}

/** The directory, relative to the repository's root, whose `SKILL.md` is named `skill`. */
async function findSkill(
  repository: string,
  commit: string,
  skill: string,
  environment: Environment,
): Promise<string> {
  const listed = await git(["-C", repository, "ls-tree", "-r", "--name-only", commit], environment);
  const files = listed.out
    .split("\n")
    .filter(
      (path) =>
        (path === "SKILL.md" || path.endsWith("/SKILL.md")) && !path.includes("node_modules/"),
    );
  const matches: string[] = [];
  const names: string[] = [];
  for (const file of files) {
    const text = await git(["-C", repository, "show", `${commit}:${file}`], environment);
    let name: string | undefined;
    try {
      ({ name } = parseSkillFile(text.out, file));
    } catch {
      // Not a skill this can load; the one asked for may still be elsewhere.
    }
    if (name) names.push(name);
    if (name === skill) matches.push(file === "SKILL.md" ? "" : file.slice(0, -"/SKILL.md".length));
  }
  if (matches.length === 0) {
    const known = names.length > 0 ? `; it has ${names.slice(0, 10).join(", ")}` : "";
    throw new Error(`no skill named ${skill} at ${commit.slice(0, 12)}${known}`);
  }
  if (matches.length > 1) {
    throw new Error(`more than one skill is named ${skill}: ${matches.join(", ")}`);
  }
  return matches[0]!;
}

/** `within` at `commit`, as files under `into`. */
async function extract(
  repository: string,
  commit: string,
  within: string,
  into: string,
  environment: Environment,
): Promise<void> {
  const tree = within === "" ? commit : `${commit}:${within}`;
  const staged = `${into}.tar`;
  await git(["-C", repository, "archive", "--format=tar", "-o", staged, tree], environment);
  const untar = Bun.spawn({ cmd: ["tar", "-xf", staged, "-C", into], stderr: "pipe" });
  if ((await untar.exited) !== 0) {
    throw new Error(`tar failed: ${(await new Response(untar.stderr).text()).trim()}`);
  }
  await rm(staged, { force: true });
  // A link in the repository arrives as a link: refused here as a path's would be.
  const check = `${into}.checked`;
  await copySkillTree(into, check);
  await rm(into, { recursive: true });
  await rename(check, into);
}

/** Never a prompt: a private repository fails instead of waiting for a password nobody types. */
function gitEnvironment(environment: Environment): Record<string, string | undefined> {
  return { ...environment, GIT_TERMINAL_PROMPT: "0" };
}

async function git(
  args: readonly string[],
  environment: Environment,
  options: { allowFailure?: boolean } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: gitEnvironment(environment),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const result = { ok: code === 0, out: out.trim(), err: err.trim() };
  if (!result.ok && !options.allowFailure) {
    throw new Error(`git ${args[0] === "-C" ? args[2] : args[0]} failed: ${result.err}`);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
