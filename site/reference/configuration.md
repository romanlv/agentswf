---
title: Configuration
description: Every environment variable and file awf reads, what each means, and its default.
---

# Configuration

awf has no settings file. A workflow says what a run does; the command line says where
it runs ([awf commands](/reference/awf)). What is left is a few environment variables, the
logins each harness keeps, and one name in `.env`.

## Environment variables

### awf's own

| Variable | Meaning | Default |
| --- | --- | --- |
| `AWF_HERDR_SESSION` | The Herdr session a run's pane agents open in. Lowercase letters, digits and `-`, up to 32, not starting with `-`. awf starts a session named `awf` or `awf-…` when it isn't running; any other name must be running already ([Harnesses](/guide/harnesses#where-panes-go)). | `awf` |
| `AWF_COORDINATOR_DIR` | Where live runs keep the socket that `awf reply`, `awf send` and events reach them through. An absolute path, outside the workflow's folder. Set it the same for the run and for the commands that answer it. | `~/.awf/coordinator` |

### Keys and tokens

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | The key for `jev`, the built-in [decision model](/guide/decisions#the-model-and-its-key). Read from the environment, else from `.env` (below). The engine holds it; no agent's environment has it. | unset: asking `jev` fails, saying the key is not set |
| `CLAUDE_CODE_OAUTH_TOKEN` | The login of a claude agent in a [sandbox](/guide/sandboxes), from `claude setup-token`. Passed into the sandbox, never on a command line. | unset: a sandboxed claude is refused |
| `CURSOR_API_KEY` | The login of a cursor agent in a sandbox, a key from Cursor's dashboard. | unset: a sandboxed cursor is refused |

Agents outside a sandbox use your harness logins as they are ([Install](/guide/install)).

### Refused

`awf run` refuses to start while any of these is set, since each would switch an agent to
per-token billing ([Harnesses](/guide/harnesses#subscription-and-metered)):

| Harness | Variables |
| --- | --- |
| claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` |
| codex | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY` |

```text
awf: runtime: subscription runtime refused metered credential environment: ANTHROPIC_API_KEY; the run did not start, and nothing of it is kept
```

Unset them in the shell you run `awf` from.

### Where harnesses keep their state

awf reads each harness's own folder to find its agents' sessions, which `awf logs` and the usage
in `output.json` come from, to copy a login into a sandboxed agent's home, and to keep sandboxes
off it. It follows the variable the harness itself follows:

| Variable | Harness | Default |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | claude; its account file is `.claude.json` in it, else `~/.claude.json` | `~/.claude` |
| `CODEX_HOME` | codex | `~/.codex` |
| `PI_CODING_AGENT_DIR` | pi | `~/.pi/agent` |
| `CURSOR_CONFIG_DIR` | cursor | `$XDG_CONFIG_HOME/cursor` when `XDG_CONFIG_HOME` is set, else `~/.cursor` |

### Others awf reads

| Variable | Meaning | Default |
| --- | --- | --- |
| `XDG_CACHE_HOME` | The skills cache is `awf/skills` under it ([Data](/reference/data#elsewhere)). | `~/.cache` |
| `GIT_SSH_COMMAND` | The ssh command git uses to fetch a skill from a repository. | `ssh -o BatchMode=yes`, so a fetch never stops to ask for a passphrase |
| `HOME` | Where `~/.awf` and each harness's default folder are. A codex agent given skills is kept from the shared ones in `$HOME/.agents/skills`. | your home |
| `DOCKER_HOST` | The docker daemon the docker sandbox uses; a `unix://` socket is kept out of every box, as is `/var/run/docker.sock` when it is unset. | docker's |
| `NO_COLOR` | Set to anything, awf's terminal output has no colour. | colour on a terminal |
| `HERDR_HOME`, `XDG_*` | Passed on to a Herdr server awf starts, where they move Herdr's own folder. | Herdr's |

### Set by Herdr

Herdr sets these in each of its panes, and `awf run --here` reads them to find the session it
was typed in ([Calling session](/guide/calling-session)): `HERDR_ENV`, `HERDR_SOCKET_PATH`,
`HERDR_PANE_ID`, `HERDR_WORKSPACE_ID` and `HERDR_TAB_ID`. It also reads the session id the
calling agent's harness sets, `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, `PI_SESSION_ID` or
`CURSOR_CONVERSATION_ID`, and passes it on to the run. You don't set any of them.

### What an agent doesn't get

Outside a sandbox an agent gets your environment, less a few names:
[Security](/guide/security#your-environment-and-env) lists them. One of them is a setting:
`CLAUDE_CODE_EFFORT_LEVEL` is removed so a claude agent runs at the effort its workflow set.

## Files

| File | Read for | Default |
| --- | --- | --- |
| `.env` in the folder you run `awf` in | `OPENROUTER_API_KEY` only, when the environment doesn't set it | none |
| the workflow file | the workflow: `awf run {file}` | none |
| `--values {file}` | a JSON object of stage values, by stage name, to start part-way ([Runs](/guide/runs#start-part-way)) | none |
| `--sandbox {file}` | a JSON sandbox spec every agent of the run works in ([Sandboxes](/guide/sandboxes)) | none |
| `~/.awf/herdr/config.toml` | the config of the Herdr sessions awf starts; awf writes it once and never overwrites it, so your edits stay | toasts and sound off |

`awf run` and `awf test` don't load `.env` as Bun otherwise would: a token in it would change how
every agent logs in ([Security](/guide/security#your-environment-and-env)). One exception: a run
with `events` that `awf emit` or `awf tick` starts in the background gets the `PATH` it was made
with, a few plain variables, and the project's `.env`, not your shell's environment
([Hosting events](/guide/hosting-events#catches)). `AWF_COORDINATOR_DIR` and `AWF_HERDR_SESSION`
are among the variables it keeps, so set them where the sender runs.

Everything awf writes, and where, is on [Data](/reference/data).
