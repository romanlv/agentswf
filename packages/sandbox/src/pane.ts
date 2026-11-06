import { randomUUID } from "node:crypto";
import type { PaneTerminal } from "./seam";
import { shellQuote } from "./secrets";

/**
 * The shell an srt agent runs its commands in, and a pane is: zsh on macOS, whose bash 3.2 writes
 * a heredoc where a sandbox denies it whatever `TMPDIR` says (X22); bash on Linux, which writes it
 * in `TMPDIR` and is there where zsh may not be.
 */
export const AGENT_SHELL: "/bin/zsh" | "/bin/bash" =
  process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";

/**
 * What a pane's login shell is typed, to become the agent's shell: `shell` run through `through`,
 * with exactly `environment`, and nothing of the operator's shell; when it exits the pane closes
 * (H6). Its pid is recorded in `pidFile` and, with job control off (`+m`), every job stays in the
 * group it leads, so a release ends them all. Its secrets are sourced from `secretsFile`, which is
 * then removed. The prompt is typed escaped and drawn plain, so the screen shows `ready` only once
 * the shell draws it: zsh takes `PROMPT` from its environment, `%%` shown as `%`; bash drops an
 * inherited `PS1` wherever a non-interactive bash is on the way, as srt's and macOS's `sh` are, so
 * `PROMPT_COMMAND` sets it, `\045` shown as `%`.
 */
export function panePrelude(options: {
  environment: Readonly<Record<string, string>>;
  pidFile: string;
  secretsFile: string;
  through: readonly string[];
  shell: "/bin/zsh" | "/bin/bash";
}): Pick<PaneTerminal, "prelude" | "ready"> {
  const nonce = randomUUID().replaceAll("-", "");
  const zsh = options.shell === "/bin/zsh";
  const environment = {
    ...options.environment,
    TERM: "xterm-256color",
    ...(zsh
      ? { PROMPT: `awf-%%-${nonce}%# ` }
      : { AWF_PROMPT: `awf-\\045-${nonce}\\$ `, PROMPT_COMMAND: 'PS1="$AWF_PROMPT"' }),
  };
  const pidFile = shellQuote(options.pidFile);
  const secretsFile = shellQuote(options.secretsFile);
  const shell = zsh ? ["/bin/zsh", "-f", "+m"] : ["/bin/bash", "--norc", "--noprofile", "+m"];
  const confined = [
    `mkdir -p "$(dirname ${pidFile})" && echo $$ > ${pidFile}`,
    `set -a; . ${secretsFile}; set +a; rm -f ${secretsFile}`,
    `exec ${[...options.through, ...shell].map(shellQuote).join(" ")}`,
  ].join("; ");
  const assignments = Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  return {
    prelude: `exec /usr/bin/env -i ${assignments} /bin/sh -c ${shellQuote(confined)}`,
    ready: zsh ? `awf-%-${nonce}% ` : `awf-%-${nonce}$ `,
  };
}
