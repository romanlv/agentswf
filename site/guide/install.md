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

`~/.bun/bin` is on your PATH if Bun's installer set it up. agents.wf is in beta, and the newest
beta is what a plain install gets.

## What you need

- **Bun 1.4 or later.**
- **git.**
- **At least one coding agent CLI, logged in:** claude, codex, pi or cursor. awf drives the CLI
  you already use, on your own login; it has no account of its own.
- **[Herdr](https://herdr.dev)**, for pane agents. A pane agent runs in a terminal pane you can
  watch and type into, and that is the default. A headless agent runs as a plain process and needs
  no Herdr. awf is built for Herdr 0.9.1, and requires exactly that version for a docker
  sandbox's own Herdr and for a Herdr session a layout names.

A workflow can live in any folder and needs nothing installed there: `awf` serves it
`agentswf/workflow` and `typebox` from its own copies, and `awf test` serves `agentswf/testing`
too.

## Each harness

A harness is the coding agent CLI an agent runs on. awf checks a harness's login when a run opens
its first agent on it, so a run that uses only codex needs no claude login.

| Harness | Command on PATH | Login it needs | Headless | In a sandbox, besides the login |
| --- | --- | --- | --- | --- |
| claude | `claude` | a Claude subscription: `claude`, then `/login` | only with `metered: true` | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` |
| codex | `codex` | a ChatGPT login: `codex login` | yes | nothing |
| pi | `pi` | one per model provider: `pi`, then `/login` | yes | nothing |
| cursor | `cursor-agent` | `cursor-agent login` | yes | `CURSOR_API_KEY`, from Cursor's dashboard |

A claude pane runs on your plan, and headless claude is refused unless its runtime says
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
- **docker**, with its daemon running and awf's image built once
  ([Sandboxes](/guide/sandboxes#catches) gives the command). A docker sandbox runs its own Herdr, so its panes show in
  the run's workspace.

A run that opens no sandbox needs neither. Which one a sandbox uses, and how to open one, is on
[Sandboxes](/guide/sandboxes#srt-or-docker).

## Editor types

`awf init` sets a folder up for writing workflows, with `agentswf` and `typebox` as dev dependencies
so your editor has types; [Quick start](/guide/quick-start) walks through it. `awf` runs a workflow
against its own copies either way.

## Updating

Run the install again:

```sh
bun add -g agentswf
```

That updates `awf` and what it serves your workflows. The types in a workflow folder are that
folder's own dev dependency; update them there with `bun add -d agentswf`.

## Catches

- **A workflow file is trusted code**: it runs with your permissions, so sandbox the agents, not
  the workflow.
- **Each harness is its own install.** awf doesn't install or update claude, codex, pi, cursor or
  Herdr; keep each logged in with its own command.
- **Work on agents.wf itself** runs from a clone instead; the
  [README](https://github.com/romanlv/agentswf#install) says how.
