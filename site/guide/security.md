---
title: Security
description: "What awf trusts and what it doesn't: the workflow, your environment and .env, what awf refuses, what each agent may do, and the gaps that are still open."
---

# Security

awf runs code you chose and coding agents that act on your behalf. This page says what each of
them can reach, what awf keeps from them, what it refuses outright, and where the boundary is
today: a [sandbox](/guide/sandboxes).

## Untrusted input goes in a sandbox

<<< @/../examples/site/guide/security.ts#reader

An issue, a pull request from a stranger or a web page can carry instructions an agent may follow.
Outside a sandbox, the text it reads decides how far it gets ([What agents may do](#what-agents-may-do)).
Inside `sandbox: { srt: {} }` the triager reads the working directory, writes nothing, reaches only its
model, and sees nothing else under your home. The whole workflow, and the test that checks the
sandbox it was given, are in
[`examples/site/guide/security.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/security.ts).

## A workflow is trusted code

`awf run review.ts` runs `review.ts` as a program, in the awf process, with your authority. It can
read your files and your environment, run commands and reach the network, as any script you run
can. Sandboxes hold agents; nothing holds the workflow.

So run a workflow only if you would run it as a script. A sandbox in a workflow protects you from
what its agents read, not from the workflow itself, which chooses what its agents get. The same
goes for what it hands them:

- **A [tool](/guide/tools) runs on the host.** When a sandboxed agent calls one, your handler runs
  in the workflow's process, outside the sandbox, with the input the agent sent. A tool is a door
  out of the sandbox that you open on purpose, so make it do only what its name says.
- **A [skill](/guide/agents#instructions-and-skills) is instructions an agent follows.** One
  fetched from a repository is whatever that repository holds at the run's start, so pin its `ref`.

To hold every agent of a workflow you didn't write to one reach, start it with
`awf run --sandbox {file}` ([Sandboxes](/guide/sandboxes)). Its code still runs on the host.

## Your environment and `.env`

`awf run` and `awf test` don't load `.env`, which Bun otherwise does: a token in it would change
how every agent logs in. They read one name from a `.env` in the folder where you run `awf`,
`OPENROUTER_API_KEY`, for [decisions](/guide/decisions#the-model-and-its-key). Everything else,
the tokens a sandboxed claude or cursor needs included, comes from the shell you run `awf` from.

One exception: a run with events that `awf emit` or `awf tick` starts in the background gets the
`PATH` it was made with, a few plain variables such as `HOME` and `SSH_AUTH_SOCK`, and the
project's `.env`, not your shell's environment. Every name in that `.env`, keys and tokens
included, reaches that run and its agents as if you had exported it
([Hosting events](/guide/hosting-events#catches)).

An agent outside a sandbox gets your environment, less these names:

- `OPENROUTER_API_KEY`. The engine makes decision calls and holds the key; no agent can read it.
- The keys that switch an agent to per-token billing, which refuse the run anyway
  ([Configuration](/reference/configuration#refused) lists them).
- What a coding agent session sets for the commands it runs, such as `CLAUDECODE`, when you run
  `awf` from inside one: an agent never sees your session's markers as its own.
- `AWF_CALLER_SESSIONS`, which `awf run --here` passes on, and `CLAUDE_CODE_EFFORT_LEVEL`, so a
  claude agent runs at the effort its workflow set.
- For a TUI agent, `HERDR_CONFIG_PATH` too, so a `herdr` started there reads your config, not the run
  session's.

Everything else reaches it: cloud credentials, a `GITHUB_TOKEN`, your SSH agent's socket. An agent
inside a sandbox gets only what the sandbox sets, its harness's login among it, and a harness home
of its own instead of yours ([Sandboxes](/guide/sandboxes#inside-a-sandbox)).

## What agents may do

**Every agent outside a sandbox runs any shell command it decides to, with your authority.** awf
has no per-tool permission rules yet, and each harness starts so that it works unattended:

| Harness | Outside a sandbox | Inside a sandbox |
| --- | --- | --- |
| claude | `--allowed-tools Bash`: any shell command without asking; its other tools follow your permission settings, and headless, with no one to ask, are denied | permission prompts off |
| codex | `--sandbox danger-full-access --ask-for-approval never` in its TUI; `sandbox_mode="danger-full-access"` headless | the same, with its apps and plugins off |
| cursor | `--force --trust` in its TUI; `--force` headless | the same, with its own sandbox off |
| pi | every tool; pi has no permission system | the same, with its extensions off |

Inside a sandbox web search is off too, unless the spec asks for it
([Sandboxes](/guide/sandboxes#inside-a-sandbox)).

Harness flags aren't a boundary anyway: an agent with a shell can start its harness again with
other flags. A sandbox sits below the harness, which can't lift it. That is why the prompts are off
inside one: the sandbox answers what they would ask.

## What awf refuses

awf stops rather than run with less than you asked for, or on a login you didn't mean:

- **Per-token billing you didn't ask for:** a key for it in your environment, claude or codex on an
  API-key login, a headless claude without `metered: true`. [Harnesses](/guide/harnesses#subscription-and-metered)
  has the rules.
- **A sandboxed claude or cursor without its token:**

  ```text
  a sandboxed claude needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`): its login lives in the keychain
  ```

- **A sandbox it can't hold whole.** The agent doesn't open; a sandbox is never wider than its
  spec ([Sandboxes](/guide/sandboxes#catches)).
- **Windows.** An agent answers over a Unix-domain socket, so awf refuses to start a run there.
- **Messages from your other claude sessions.** Claude Code can pass messages between the claude
  sessions on your machine. An agent's claude refuses them, so nothing reaches it but the workflow
  and the peers it [grants](/guide/messaging).

## Known gaps

- **Outside a sandbox, an agent has your authority:** it can write anywhere you can, reach any
  host, and read the credentials in your environment and home.
- **A sandboxed agent still uses your login.** Its turns run on your subscription. codex and pi
  work from a copy of your login file, and when the copy refreshes its token, awf writes it back to
  yours if yours hasn't changed meanwhile. Whether that refresh ever signs out your own codex or pi
  hasn't been measured; if it does, log in again (`codex login`, or `/login` in `pi`).
- **No per-tool permissions.** You can't yet say which tools an agent may use.
- **A refused headless claude is found late.** It's refused when it opens, which may be after
  other agents in the run have already done work.

The current list, with what runs today, is
[on GitHub](https://github.com/romanlv/agentswf/blob/main/docs/status.md#known-gaps). The design
behind sandboxes and permissions is in
[`docs/design/permissions.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/permissions.md).

## See also

- [Sandboxes](/guide/sandboxes): opening one, sharing it, srt or docker
- [Harnesses](/guide/harnesses#subscription-and-metered): subscription and metered
- [Configuration](/reference/configuration#environment-variables): every environment variable awf
  reads or refuses
