import type { RuntimeAliases } from "@agentswf/contract/workflow";

/**
 * The runtime aliases `awf run` installs. A workflow's test starts from the same ones, so an alias
 * a run would not know fails the test too.
 */
export const OPERATOR_ALIASES: RuntimeAliases = Object.freeze({
  claude: { harness: "claude", model: "sonnet" },
  codex: { harness: "codex", model: "gpt-5.6-sol" },
});
