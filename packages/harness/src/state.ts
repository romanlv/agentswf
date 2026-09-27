import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness } from "./types";

type Environment = Readonly<Record<string, string | undefined>>;

/** The variable that moves each harness's state, which a sandboxed agent's home is given by. */
export const HOME_ENV = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
} as const satisfies Partial<Record<Harness, string>>;

/** The operator's own state directory for each harness, where its environment moved it or not. */
export function harnessState(
  environment: Environment = process.env,
): Readonly<Record<Harness, string>> {
  const home = environment.HOME ?? homedir();
  return {
    claude: environment[HOME_ENV.claude] ?? join(home, ".claude"),
    codex: environment[HOME_ENV.codex] ?? join(home, ".codex"),
    pi: environment[HOME_ENV.pi] ?? join(home, ".pi", "agent"),
    cursor: join(home, ".cursor"),
  };
}
