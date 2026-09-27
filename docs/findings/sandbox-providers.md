# Sandbox providers: what srt and docker hold

Story 004's Task 0, run 2026-09-25 on macOS 26 (Darwin 25.6), srt CLI 1.0.0, OrbStack docker
29.4.0 linux/arm64. Each row ran once, from a throwaway script that was not kept; the sandbox's
tests and live evals now check what the design rests on. Live rows ran on the operator's
subscriptions, and claude on a setup token.

| # | Question | Result |
|---|---|---|
| X1 | Does SIGKILL on `srt` end its child? | **No.** The child survives. A process-group kill (spawn detached, kill `-pid`) ends it. |
| X2 | Door rules under srt | **Hold.** The listed socket connects inside a `denyWrite` directory. Writing the launcher, unlinking the socket and connecting to an unlisted socket are refused. |
| X3 | Bundled `wf` under srt | **Works** with only host bun's real path and the bundle readable. |
| X4 | Temp and localhost | **Denied:** `/tmp`, `/private/tmp`, `$TMPDIR`, `/tmp/claude-501` and a localhost listener. `sh` works. **git fails**: an unreadable `~/.gitconfig` is fatal. `GIT_CONFIG_GLOBAL` fixes it. |
| X5 | Headless turns with a fresh home, under srt | **All three pass**, turn and resume, with *no* config files: no trust, onboarding or bypass answers. Homes after a turn: codex 4.8 MB, claude 448 KB, pi 24 KB. |
| X6 | Host socket into a container | **Not connectable** on OrbStack, whether its directory or the file is mounted, from `/tmp` or `~`. A `docker exec -i` stdio relay carried 50/50 concurrent calls in 24 ms. |
| X7 | SIGKILL on a `docker exec` client | **The processes inside survive.** Launching as `setsid sh -c 'echo $$ > pidfile; exec …'` and running `docker exec {box} kill -9 -{pid}` ends the whole group; with `--init`, no zombie remains. |
| X8 | `--internal` network plus a filtering proxy | **Holds.** Refused: a non-allowed domain, a subdomain of an exact name, a raw IP, going around the proxy, DNS and raw TCP. The allowlist grew while the proxy ran. codex and pi (node) honour `HTTPS_PROXY`. |
| X9 | Session files at identical paths | **Yes** for all three, owned by uid 501 on the host. |
| X10 | claude on `CLAUDE_CODE_OAUTH_TOKEN` | **Works** under srt and in a box, with a fresh `CLAUDE_CONFIG_DIR`. `.claude.json` lands inside it, and `auth status` reports `oauth_token`. `-p` reports `total_cost_usd` (a Haiku turn: $0.019); whether the subscription or a per-token bill pays is not visible from here. |
| X11 | Bundle under the image's bun | **Works** (bun 1.4.2), copied in with `docker cp`. |
| X12 | Docker timings | Box start 0.23 s; network, proxy and box 0.65 s; one `exec` 37 ms; teardown 0.2–0.3 s. |
| X13 | Does a copied `auth.json` rotate? | **Not seen** in 4 turns. Forcing a refresh could log the operator out: not run. |
| X14 | Keychain under srt | **Not readable** through `security`, even naming the login keychain's path. The residual did not reproduce. |
| X15 | Model-side web search | codex and claude both searched **inside srt, past the allowlist**. codex: `-c web_search="disabled"` removes the tool, and `tools.web_search=false` does not. claude: `--disallowed-tools WebSearch WebFetch` removes it. pi's core has none. |
| X16 | Two sandboxes under srt | **Isolated:** each reads and writes its own home; the other's home, temp and the run root are denied. Docker by construction: each box mounts only its own directory. |
| X17 | A home created after the box started | **Visible and writable** at once, through the `homes/` mount. |
| X18 | Two agents in one box at once | **Pass:** codex and pi, separate homes, both answered. |
| X19 | The project's toolchain under srt | **Install roots needed.** With `PATH`'s directories under `~` allowed, bun and node run and npm fails, as its library sits beside `bin/`. With the parent of each `bin` allowed (`~/.bun`, `~/.local`, a mise node install, `~/.orbstack`), bun, node and npm run. |
| X20 | Headless turns under srt with a clean environment (`env -i`) | **All three answer:** claude, codex and pi, with only `HOME`, `PATH` (the harness link, the toolchain's `bin` directories, `/usr/bin:/bin:/usr/sbin:/sbin`), the home variables, `GIT_CONFIG_GLOBAL`, `CLAUDE_CODE_TMPDIR` and claude's token. bun, node and npm run from that `PATH`. Inside, srt adds its proxy variables, `TMPDIR`, `GIT_SSH_COMMAND` and `GIT_CONFIG_PARAMETERS`. |
| X21 | A process that starts its own session (`setsid`) inside srt, once its launch's group is killed | **It survives**, reparented to launchd in a group of its own, still confined by srt. macOS `ps` shows no process's environment, so no marker finds it either. Run 2026-09-26. Docker's box removal ends one there; under srt it lives until it exits. |
| X22 | A heredoc under srt, as every prompt's `wf result <<'WF_JSON'` is | **Failed until fixed:** zsh writes it under `TMPPREFIX` (`/tmp/zsh` by default) and macOS's bash 3.2 under `/var/tmp`, whatever `TMPDIR` says, and only when it may write the directory. So codex's and pi's answers were lost while claude's got through. bash also falls back to the working directory when that is writable, which is why the shared sandbox's claude got through. `SHELL=/bin/zsh`, `TMPPREFIX` in the sandbox's temp, and pi told to use zsh fix it; making `/var/tmp` writable also worked, but let every sandbox overwrite, link and read one another's files there. Found by the Task 4 eval, 2026-09-26. `/var/tmp` had been readable by every agent; it is denied now. |
| X23 | codex's model-side tools beyond web search, in a fresh home | codex listed `mcp__codex_apps__*` tools: plugin management (uninstalling apps, changing their permissions) and sites, acting through the login on the operator's ChatGPT account. `-c features.apps=false`, `features.plugins=false` and `features.remote_plugin=false` take them away, as `codex features list` confirms. Found by the Task 4 eval, 2026-09-26. |
| Y1 | Other routes for docker's door | **TCP to the host** from an `--internal` box: unreachable. **A FIFO** across the mount: hangs. **A file-drop mailbox** (box writes a request, host watches and replies): works, 14–57 ms a round trip. |

## Headed agents in docker

Run 2026-09-25 with herdr 0.8.2 on the host and 0.9.1 in the box, in a scratch Herdr session
started with a clean environment: one started from a Claude Code session passes its markers on. H4 and H6 were
run again on 2026-09-26 with 0.9.1 on the host, with the same results.

| # | Question | Result |
|---|---|---|
| H1 | A host pane whose outermost process is `docker exec -it {box} bash` | **The shell and a claude TUI run in the box, but Herdr does not see the agent.** `agent start` refuses the pane ("not an available shell", as its foreground process is `docker`), and a claude typed in by `pane run` stays `agent_status: unknown`: no `agent prompt --wait` or `agent read`. |
| H2 | Herdr's server inside the box, driven by `docker exec {box} herdr …` | **Works.** `agent start` detected a TUI claude in 4 s, `agent prompt --wait` ran a turn to `done` in 4 s, `agent read` showed the answer, and the session file landed on the host. A host pane running `docker exec -it {box} herdr` shows the box's session to the operator. |
| H3 | codex and pi TUIs in a boxed Herdr, with and without trust answers | pi answers with its credential alone. **codex without its folder trust loses the prompt** (status `done`, nothing asked); with agent-box's `config.toml` trust it answers. claude, per the study and H2, needs onboarding, trust and bypass answers. Panes need `defaults`; headless does not. |
| H4 | An srt pane: `exec srt … zsh` as the pane's root in the host's Herdr | **`agent start` refuses it** (the root is srt's node, not a shell). **Typing claude with `pane run` works:** Herdr detects it, `agent rename` names it, `agent prompt --wait` reaches `done`, the answer is right, `~/.zshrc` is unreadable, and closing the tab leaves no claude process. The pane's minimal `PATH` needs node and srt by absolute path. |
| H5 | Typed start in the box, with the token from a file | **Works:** detected, renamed, prompted, answered. The token, sourced from a `0600` file in the home, is in no process's arguments in the box. Closing the tab leaves no claude process in the box. |
| H6 | The srt pane's start, step by step | With an `env -i` prelude: the confined environment holds only what it set plus srt's proxy variables; the token comes from `.secrets` and is in no argv. Before detection `agent rename` says `agent_not_found`; detection takes about 1 s. claude and codex (quoted `-c 'web_search="disabled"'`) both answer after `agent wait --until idle`. Both Herdr sockets under `~` are refused. **`agent_session` is null for adopted agents**, where an unsandboxed `agent start` gets `herdr:claude`. Without `allowPty`, zsh cannot set the terminal's process group and nothing is detected. When the confined shell exits, the pane closes. Closing the tab ends srt, its children and claude. srt needs `bash` on `PATH`. Even unsandboxed, a prompt sent right after `agent start` reported `idle` stalled. |

## What else surfaced

- **srt parses options after the command** unless the command follows `--`: `srt -s f codex
  --version` prints srt's version. A launch is `srt -s {file} -- {real_path} {args}`.
- **argv[0] must be the real path.** `~/.local/bin` is denied, so `codex` is not found on `PATH`.
- **codex needs srt's `enableWeakerNetworkIsolation`.** Without it every TLS request fails. It
  adds one rule, `mach-lookup com.apple.trustd.agent`, which is certificate verification.
- **Minimal domains.** claude: `api.anthropic.com`. codex and pi (ChatGPT login): `chatgpt.com`
  and `*.chatgpt.com`. Also asked for, denied, and harmless: codex's `*.oaiusercontent.com`, and
  claude's Datadog log intake.
- **pi needs no `settings.json`** when `--model` names the model: `auth.json` alone (X5, X9).
- **claude's `web_search_requests` counter reads 0** even when it searched. The transcript's
  `WebSearch` tool calls are the evidence.
- **A box has no `/private`.** The in-box launcher directory at the host path is made by root at
  admission.
- **The proxy is about twenty lines of node** (`proxy.js`), CONNECT only, re-reading its list per
  request. Its list must sit in a mounted *directory*: a single-file mount returned ENOENT once
  the file was deleted and recreated at the same path. A refused client that resets its
  connection crashed an earlier version; every socket now has an error handler.
- **In a box, Herdr, claude and pi try to update themselves** (`herdr.dev`, `downloads.claude.ai`,
  `pi.dev`, GitHub). All were refused, harmlessly.
