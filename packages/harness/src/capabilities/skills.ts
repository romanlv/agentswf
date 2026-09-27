import { readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * An agent's skills, each copied to `directory/{name}`, and the home it has for them when it runs
 * on the host with one of its own. What the harness finds beyond them, its repository's own and
 * its bundled ones, stays (story 007).
 */
export type AgentSkills = {
  directory: string;
  names: readonly string[];
  /** codex's home on the host, which `CODEX_HOME` points it at. */
  home?: string;
};

/**
 * Where the engine copies an agent's skills for `harness`: into its home when it has one, a
 * sandboxed agent's or a host codex's, and otherwise into `bundle`, a directory of the agent's own.
 * `home: "needed"` asks the engine for a home on the host. Rejects a harness with no route.
 */
export function skillsLayout(
  harness: string,
  where: { home?: string; bundle: string },
): { directory: string; home: "needed" | "given" | "none" } {
  switch (harness) {
    case "claude":
      // A home of its own on the host would need a setup token: its login is in the keychain.
      return where.home
        ? { directory: join(where.home, "skills"), home: "given" }
        : { directory: join(where.bundle, ".claude", "skills"), home: "none" };
    case "codex":
      // Nothing points codex at a skill but its home (findings/agent-skills.md, K11).
      return where.home
        ? { directory: join(where.home, "skills"), home: "given" }
        : { directory: join(where.bundle, "home", "skills"), home: "needed" };
    case "pi":
      return where.home
        ? { directory: join(where.home, "skills"), home: "given" }
        : { directory: join(where.bundle, "skills"), home: "none" };
    default:
      throw new Error(`${harness} has no way to be given skills; an agent with skills is refused`);
  }
}

/**
 * The arguments and environment that hold `harness` to `skills`, on every turn and at a pane's
 * start. On the host they also shut out the operator's own; in a sandbox the fresh home already
 * holds none of them.
 */
export async function skillsLaunch(
  harness: string,
  skills: AgentSkills,
  sandboxed: boolean,
  environment: Environment = process.env,
): Promise<{ args: string[]; env: Record<string, string> }> {
  switch (harness) {
    case "claude":
      if (sandboxed) return { args: [], env: {} };
      // Without the user source: its skills, and also its hooks and settings (K5). `--add-dir` is
      // variadic, so it is followed by a flag wherever these go.
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
      if (sandboxed) return { args, env: {} };
      if (!skills.home) throw new Error("codex on the host needs a home of its own for skills");
      // codex reads `~/.agents/skills` through `HOME`, whatever its own home is (K7), and has only
      // a switch per skill: listed at each start, so one the operator adds meanwhile is off too.
      const operators = await operatorSkillFiles(environment);
      if (operators.length > 0) {
        const entries = operators.map((path) => `{path=${JSON.stringify(path)},enabled=false}`);
        args.push("-c", `skills.config=[${entries.join(",")}]`);
      }
      return { args, env: { CODEX_HOME: skills.home } };
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

/** Each `SKILL.md` under `~/.agents/skills`, by the real path codex compares. */
async function operatorSkillFiles(environment: Environment): Promise<string[]> {
  const root = join(environment.HOME ?? "", ".agents", "skills");
  if (!environment.HOME) return [];
  const entries = await readdir(root).catch(() => [] as string[]);
  const files: string[] = [];
  for (const entry of entries) {
    const file = await realpath(join(root, entry, "SKILL.md")).catch(() => undefined);
    if (file) files.push(file);
  }
  return files.sort();
}
