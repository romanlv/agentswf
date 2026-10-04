import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness } from "./types";

type Environment = Readonly<Record<string, string | undefined>>;

/** The variable that moves each harness's state, as the harness reads it, where one does. */
export const HOME_ENV = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
  cursor: "CURSOR_CONFIG_DIR",
} as const satisfies Record<Harness, string>;

/**
 * Where each harness keeps its state when its variable is unset. cursor's is its config directory,
 * which holds its chats; much else of it stays under `HOME/.cursor` whatever moves this.
 */
const DEFAULT_STATE: Record<Harness, (home: string, environment: Environment) => string> = {
  claude: (home) => join(home, ".claude"),
  codex: (home) => join(home, ".codex"),
  pi: (home) => join(home, ".pi", "agent"),
  cursor: (home, environment) =>
    environment.XDG_CONFIG_HOME?.trim()
      ? join(environment.XDG_CONFIG_HOME, "cursor")
      : join(home, ".cursor"),
};

/** The operator's own state directory for each harness, where its environment moved it or not. */
export function harnessState(
  environment: Environment = process.env,
): Readonly<Record<Harness, string>> {
  const home = environment.HOME ?? homedir();
  const state = (harness: Harness) =>
    environment[HOME_ENV[harness]]?.trim() || DEFAULT_STATE[harness](home, environment);
  return {
    claude: state("claude"),
    codex: state("codex"),
    pi: state("pi"),
    cursor: state("cursor"),
  };
}

/**
 * The skills root several harnesses share, which codex reads through `HOME` whatever its own home
 * is (findings/agent-skills.md, K7). Absent when nothing names a home.
 */
export function sharedSkillsRoot(environment: Environment = process.env): string | undefined {
  return environment.HOME ? join(environment.HOME, ".agents", "skills") : undefined;
}
