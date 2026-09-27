import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { sharedSkillsRoot } from "../state";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Where an agent's skills go for its harness, and what holds the harness to them. The engine
 * copies each to `directory/{name}` and, when `ownHome` is set, seeds that home first; everything
 * else about the layout is this module's. Beyond these, claude keeps its working directory's skills
 * and its bundled ones, codex its working directory's, and pi nothing.
 */
export type AgentSkills = {
  names: readonly string[];
  directory: string;
  /** A home of the agent's own on the host, which `directory` is inside: codex finds skills only there. */
  ownHome?: string;
  /** In a sandbox, whose fresh home holds nothing of the operator's to shut out. */
  sandboxed: boolean;
};

/**
 * `names`' place for `harness`: a sandboxed agent's home, or on the host a directory the engine
 * made for the agent alone, outside `cwd`, both by their real paths. Rejects a harness with no way
 * to be given skills.
 */
export function skillsLayout(
  harness: string,
  names: readonly string[],
  where: { sandboxHome: string } | { bundle: string; cwd: string },
): AgentSkills {
  if (!["claude", "codex", "pi"].includes(harness)) {
    throw new Error(`${harness} has no way to be given skills; an agent with skills is refused`);
  }
  if ("sandboxHome" in where) {
    return { names, directory: join(where.sandboxHome, "skills"), sandboxed: true };
  }
  switch (harness) {
    // A home of its own would need a setup token: claude's login is in the keychain.
    case "claude": {
      // claude drops an `--add-dir` inside its working directory, and says nothing.
      const inside = relative(where.cwd, where.bundle);
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
        throw new Error(
          `claude cannot be given skills from ${where.bundle}, inside its working directory; put the run root outside it`,
        );
      }
      return { names, directory: join(where.bundle, ".claude", "skills"), sandboxed: false };
    }
    // Nothing points codex at a skill but its home (K11).
    case "codex": {
      const ownHome = join(where.bundle, "home");
      return { names, directory: join(ownHome, "skills"), ownHome, sandboxed: false };
    }
    default:
      return { names, directory: join(where.bundle, "skills"), sandboxed: false };
  }
}

/** The arguments and environment that hold `harness` to `skills`, on every turn and pane start. */
export async function skillsLaunch(
  harness: string,
  skills: AgentSkills,
  environment: Environment = process.env,
): Promise<{ args: string[]; env: Record<string, string> }> {
  switch (harness) {
    case "claude":
      if (skills.sandboxed) return { args: [], env: {} };
      // Without the user source: its skills, and also its hooks and settings (K5). `--add-dir` is
      // variadic, so a flag must follow it wherever these go.
      return {
        args: [
          "--setting-sources",
          "project,local",
          "--add-dir",
          dirname(dirname(skills.directory)),
        ],
        env: {},
      };
    case "codex": {
      const args = ["-c", "skills.bundled.enabled=false"];
      if (skills.sandboxed) return { args, env: {} };
      if (!skills.ownHome) throw new Error("codex on the host needs a home of its own for skills");
      // A switch per skill is all codex has: listed at each start, so one added meanwhile is off too.
      const operators = await sharedSkillFiles(environment);
      if (operators.length > 0) {
        const entries = operators.map((path) => `{path=${tomlString(path)},enabled=false}`);
        args.push("-c", `skills.config=[${entries.join(",")}]`);
      }
      return { args, env: { CODEX_HOME: skills.ownHome } };
    }
    case "pi":
      return {
        args: [
          "--no-skills",
          ...skills.names.flatMap((name) => ["--skill", join(skills.directory, name)]),
        ],
        env: {},
      };
    default:
      throw new Error(`${harness} has no way to be given skills`);
  }
}

/** Each `SKILL.md` in the shared root, by the real path codex compares. */
async function sharedSkillFiles(environment: Environment): Promise<string[]> {
  const root = sharedSkillsRoot(environment);
  if (!root) return [];
  const files: string[] = [];
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const file = await realpath(join(root, entry, "SKILL.md")).catch(() => undefined);
    if (file) files.push(file);
  }
  return files.sort();
}

/** A TOML basic string: JSON's escapes are all TOML's, and DEL, which JSON leaves raw, TOML refuses. */
function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll("\x7f", "\\u007F");
}
