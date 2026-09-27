import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSkillsRecord, SkillRecord } from "@wf/contract/records";
import type { SkillSource } from "@wf/contract/workflow";
import { cachedRepository, extract, fetchCommit, findSkill } from "./fetch";
import { parseSkillFile, repositoryUrl } from "./sources";
import { copySkillTree, digestTree } from "./tree";

export { parseSkillFile, readSkillSources } from "./sources";

type Environment = Readonly<Record<string, string | undefined>>;

/** A skill resolved for this run: a checked snapshot every agent naming it is copied from. */
export type ResolvedSkill = {
  name: string;
  /** The run's snapshot, which no agent reaches. */
  snapshot: string;
  record: SkillRecord;
};

/**
 * A run's skills: each source resolved once, so every agent naming it gets the same files, into a
 * snapshot under the run directory; then a copy per agent, and the record of what each agent had.
 */
export class RunSkills {
  readonly #resolved = new Map<string, Promise<ResolvedSkill>>();
  /** Each repository's last fetch in line: git's shallow lock refuses a second one at once. */
  readonly #fetching = new Map<string, Promise<unknown>>();
  /** Each (URL, ref)'s commit, so two skills from one repository's `main` get one commit. */
  readonly #commits = new Map<string, Promise<string>>();
  readonly #records: AgentSkillsRecord[] = [];
  readonly #root: string;
  readonly #cache: string;
  readonly #environment: Environment;

  constructor(options: { runDir: string; cacheRoot?: string; environment?: Environment }) {
    this.#environment = options.environment ?? process.env;
    // Absolute: git runs in the cache's repository, and a harness is pointed at these paths.
    this.#root = resolve(options.runDir, "skills");
    this.#cache = resolve(options.cacheRoot ?? defaultCacheRoot(this.#environment));
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

  /** What an agent was given, and the home of its own it ran with on the host, if any. */
  record(agent: string, skills: "operator" | readonly ResolvedSkill[], home?: string): void {
    this.#records.push({
      callPath: [],
      agent,
      skills: skills === "operator" ? "operator" : skills.map((skill) => ({ ...skill.record })),
      ...(home === undefined ? {} : { home }),
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
    const repository = await cachedRepository(this.#cache, url, this.#environment);
    const commit = await this.#commit(repository, url, source.ref);
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

  #commit(repository: string, url: string, ref: string | undefined): Promise<string> {
    const key = `${url}\0${ref ?? ""}`;
    let commit = this.#commits.get(key);
    if (!commit) {
      const fetch = () => fetchCommit(repository, url, ref, this.#environment);
      commit = (this.#fetching.get(repository) ?? Promise.resolve()).then(fetch, fetch);
      this.#fetching.set(
        repository,
        commit.catch(() => undefined),
      );
      this.#commits.set(key, commit);
      const settled = commit;
      settled.catch(() => {
        if (this.#commits.get(key) === settled) this.#commits.delete(key);
      });
    }
    return commit;
  }

  /** A fresh directory under the run's, filled by `fill` before it is used. */
  async #snapshot(fill: (into: string) => Promise<void>): Promise<string> {
    const snapshot = join(this.#root, "sources", randomUUID());
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    await fill(snapshot);
    return snapshot;
  }
}

/**
 * Copies each skill into `directory/{name}`. The directory is made even for none: a harness pointed
 * at it must find it.
 */
export async function placeSkills(
  skills: readonly ResolvedSkill[],
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const skill of skills) await copySkillTree(skill.snapshot, join(directory, skill.name));
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
