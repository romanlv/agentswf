import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { sharedSkillsRoot } from "../state";
import { type Absent, type Harness, isAbsent } from "../types";

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

type Launch = { args: string[]; env: Record<string, string> };

/** How a harness is given skills: their place on the host, and what holds it to them. */
type SkillsSupport = {
  /** A directory the engine made for the agent alone, outside `cwd`, by its real path. */
  onHost: ((names: readonly string[], bundle: string, cwd: string) => AgentSkills) | Absent;
  /** Where they go in a sandboxed agent's home; absent, its `skills`. */
  inSandbox?(home: string): string;
  launch(skills: AgentSkills, environment: Environment): Promise<Launch> | Launch;
};

const SKILLS: Readonly<Record<Harness, SkillsSupport | Absent>> = {
  // A home of its own would need a setup token: claude's login is in the keychain.
  claude: {
    onHost: (names, bundle, cwd) => {
      // claude drops an `--add-dir` inside its working directory, and says nothing.
      const inside = relative(cwd, bundle);
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
        throw new Error(
          `claude cannot be given skills from ${bundle}, inside its working directory; put the run root outside it`,
        );
      }
      return { names, directory: join(bundle, ".claude", "skills"), sandboxed: false };
    },
    // Without the user source: its skills, and also its hooks and settings (K5). `--add-dir` is
    // variadic, so a flag must follow it wherever these go.
    launch: (skills) =>
      skills.sandboxed
        ? { args: [], env: {} }
        : {
            args: [
              "--setting-sources",
              "project,local",
              "--add-dir",
              dirname(dirname(skills.directory)),
            ],
            env: {},
          },
  },
  // Nothing points codex at a skill but its home (K11).
  codex: {
    onHost: (names, bundle) => {
      const ownHome = join(bundle, "home");
      return { names, directory: join(ownHome, "skills"), ownHome, sandboxed: false };
    },
    launch: async (skills, environment): Promise<Launch> => {
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
    },
  },
  pi: {
    onHost: (names, bundle) => ({ names, directory: join(bundle, "skills"), sandboxed: false }),
    launch: (skills) => ({
      args: [
        "--no-skills",
        ...skills.names.flatMap((name) => ["--skill", join(skills.directory, name)]),
      ],
      env: {},
    }),
  },
  // It reads them under `HOME/.cursor`, and under its working directory's own roots.
  cursor: {
    onHost: {
      absent:
        "cursor reads skills under HOME, which only a home of its own shuts the operator's out of, and it has one only in a sandbox",
    },
    inSandbox: (home) => join(home, ".cursor", "skills"),
    launch: () => ({ args: [], env: {} }),
  },
};

function support(harness: string): SkillsSupport {
  const entry = Object.hasOwn(SKILLS, harness)
    ? SKILLS[harness as Harness]
    : { absent: "it is not a harness awf knows" };
  if (isAbsent(entry)) {
    throw new Error(
      `${harness} has no way to be given skills (${entry.absent}); an agent with skills is refused`,
    );
  }
  return entry;
}

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
  const skills = support(harness);
  if ("sandboxHome" in where) {
    const directory = skills.inSandbox?.(where.sandboxHome) ?? join(where.sandboxHome, "skills");
    return { names, directory, sandboxed: true };
  }
  if (isAbsent(skills.onHost)) {
    throw new Error(`${harness} cannot be given skills on the host: ${skills.onHost.absent}`);
  }
  return skills.onHost(names, where.bundle, where.cwd);
}

/** The arguments and environment that hold `harness` to `skills`, on every turn and pane start. */
export async function skillsLaunch(
  harness: string,
  skills: AgentSkills,
  environment: Environment = process.env,
): Promise<Launch> {
  return support(harness).launch(skills, environment);
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
