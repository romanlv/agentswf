import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillSource } from "@wf/contract/workflow";

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
export function repositoryUrl(repo: string): string {
  if (GITHUB_SHORTHAND.test(repo)) return `https://github.com/${repo}.git`;
  if (/^(?:https?|ssh|git|file):\/\//.test(repo) || /^[\w.-]+@[\w.-]+:/.test(repo)) return repo;
  throw new Error(`skill repo ${repo} is neither owner/repo nor a git URL`);
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
