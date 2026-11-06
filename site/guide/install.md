---
title: Install
description: What awf needs on your machine, per harness and for sandboxes, how a workflow folder gets editor types, and how to update.
---

# Install

awf runs on [Bun](https://bun.sh), on macOS or Linux. You install one package, `agentswf`, which
puts the `awf` command on your PATH and gives a workflow its imports.

```sh
bun add -g agentswf   # puts awf in ~/.bun/bin
awf --version
```

`~/.bun/bin` is on your PATH if Bun's installer set it up. A plain install gets the newest
release.

## What you need

- **Bun 1.4 or later.**
- **git.**
- **At least one coding agent CLI, logged in:** claude, codex, pi or cursor. awf drives the CLI
  you already use, on your own login; it has no account of its own.
- **[Herdr](https://herdr.dev)**, for TUI agents. A TUI agent runs its harness's own interface in a terminal pane you can
  watch and type into, and that is the default. A headless agent runs as a plain process and needs
  no Herdr. awf is built for Herdr 0.9.1, and requires exactly that version for a docker
  sandbox's own Herdr.

A workflow can live in any folder and needs nothing installed there: `awf` serves it
`agentswf/workflow`, `agentswf/typebox` and `typebox` from its own copies, and `awf test` serves
`agentswf/client` and `agentswf/testing` too. A folder that declares `agentswf` runs on the one it
installs.

## Each harness

A harness is the coding agent CLI an agent runs on. awf checks a harness's login when a run opens
its first agent on it, so a run that uses only codex needs no claude login.

| Harness | Command on PATH | Login it needs | Headless | In a sandbox, besides the login |
| --- | --- | --- | --- | --- |
| claude | `claude` | a Claude subscription: `claude`, then `/login` | only with `metered: true` | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` |
| codex | `codex` | a ChatGPT login: `codex login` | yes | nothing |
| pi | `pi` | one per model provider: `pi`, then `/login` | yes | nothing |
| cursor | `cursor-agent` | `cursor-agent login` | yes | `CURSOR_API_KEY`, from Cursor's dashboard |

A claude TUI agent runs on your plan, and headless claude is refused unless its runtime says
`metered: true`; [Harnesses](/guide/harnesses#subscription-and-metered) says why, and what awf refuses
in your environment.

claude and codex must be on a subscription login, not an API key; otherwise the agent doesn't open:

```text
Codex subscription authentication is required (ChatGPT login); `codex login status` reads as …
```

pi's login is per provider, so awf doesn't check it up front. A login a turn finds missing or
refused, pi's or one that lapsed mid-run, fails that turn at once, and its reason names the command
to run:

```text
pi needs a login for openai-codex: run `pi`, then /login (pi said: No API key found for openai-codex.)
```

claude and cursor keep their logins in the macOS keychain, which a sandbox can't reach, so a
sandboxed agent of theirs reads a token from awf's environment instead.

## Sandboxes

A sandbox limits what an agent can write and reach. It needs one of:

- **srt**, Anthropic's [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime),
  with `srt` and `node` on your PATH, and bubblewrap on Linux. On its first use in a run awf checks
  that srt really confines on this machine, and stops if it doesn't.
- **docker**, with its daemon running and awf's image built once: the first docker sandbox stops
  with the `docker build` command to run
  ([Troubleshooting](/guide/troubleshooting#docker-the-sandbox-image-image-is-not-built)). A docker
  sandbox runs its own Herdr, so its panes show in the run's workspace.

A run that opens no sandbox needs neither. Each sandbox names the one it uses:
[Sandboxes](/guide/sandboxes#srt-or-docker).

## Editor types

`awf init` sets a folder up for writing workflows, with `agentswf` and `typebox` as dev dependencies
so your editor has types; [Quick start](/guide/quick-start) walks through it. Once installed there,
that `agentswf` is the folder's engine, as the next section says.

## Updating

A folder with no `agentswf` of its own runs on the global `awf`. Run the install again to update
it:

```sh
bun add -g agentswf
```

A folder `awf init` set up has its own `agentswf`, and that is what runs its workflows: the global
`awf`, run in that folder at another version, warns and hands the command over to it. Update it
in the folder, then run the `check` and `test` scripts [`awf init`](/guide/quick-start) wrote:

```sh
bun add -d agentswf
bun run check   # tsc --noEmit
bun run test    # awf test
```

Until `bun install` has run, a folder that declares `agentswf` without installing it is refused,
naming `bun install`.

A release can improve the API. If it changed something your workflow uses, these show where,
before any agent runs; hand the errors and the current [`llms.txt`](https://agents.wf/llms.txt)
to your coding agent, and it moves the workflow over.

## Catches

- **A workflow file is trusted code**: it runs with your permissions, so sandbox the agents, not
  the workflow ([Security](/guide/security#a-workflow-is-trusted-code)).
- **Each harness is its own install.** awf doesn't install or update claude, codex, pi, cursor or
  Herdr; keep each logged in with its own command.
- **Work on agents.wf itself** runs from a clone instead; the
  [README](https://github.com/romanlv/agentswf#install) says how.

## Next

- [Quick start](/guide/quick-start): a first workflow, its free test, and one real run.
- [Harnesses](/guide/harnesses): models, effort, and which logins a run uses.
- [Troubleshooting](/guide/troubleshooting): what a refused login or a missing Herdr prints.
- [Configuration](/reference/configuration): every environment variable awf reads or refuses.
