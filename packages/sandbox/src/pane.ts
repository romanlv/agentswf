import { randomUUID } from "node:crypto";
import type { PaneTerminal } from "./seam";
import { shellQuote } from "./secrets";

/**
 * What a pane's login shell is typed, to become the agent's shell: a zsh run through `through`,
 * with exactly `environment`, and nothing of the operator's shell; when it exits the pane closes
 * (H6). Its pid is recorded in `pidFile` and, with job control off (`+m`), every job stays in the
 * group it leads, so a release ends them all. Its secrets are sourced from `secretsFile`, which is
 * then removed. zsh takes `PROMPT` from its environment, typed as `%%` and shown as `%`, so the
 * screen shows `ready` only once zsh draws it.
 */
export function panePrelude(options: {
  environment: Readonly<Record<string, string>>;
  pidFile: string;
  secretsFile: string;
  through: readonly string[];
}): Pick<PaneTerminal, "prelude" | "ready"> {
  const nonce = randomUUID().replaceAll("-", "");
  const environment = {
    ...options.environment,
    TERM: "xterm-256color",
    PROMPT: `awf-%%-${nonce}%# `,
  };
  const pidFile = shellQuote(options.pidFile);
  const secretsFile = shellQuote(options.secretsFile);
  const confined = [
    `mkdir -p "$(dirname ${pidFile})" && echo $$ > ${pidFile}`,
    `set -a; . ${secretsFile}; set +a; rm -f ${secretsFile}`,
    `exec ${[...options.through, "/bin/zsh", "-f", "+m"].map(shellQuote).join(" ")}`,
  ].join("; ");
  const assignments = Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  return {
    prelude: `exec /usr/bin/env -i ${assignments} /bin/sh -c ${shellQuote(confined)}`,
    ready: `awf-%-${nonce}% `,
  };
}
