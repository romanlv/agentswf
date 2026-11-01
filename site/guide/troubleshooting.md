---
title: Troubleshooting
description: "What awf's error messages mean and what to do about each: logins, API keys, Herdr, sandboxes, an agent that never answers, a run that stopped, type errors."
---

# Troubleshooting

Each entry starts with the message awf prints, as you see it. Search this page for its first
words. A message from the `awf` command itself starts `awf: ` on stderr. A run that ended prints
its reason in its closing lines, and `awf runs {run}` shows it again later
([Following runs](/guide/following-runs)).

Where a message holds a name, a path or a number, this page writes it as `{name}`.

## Installing and starting

### `command not found: awf`

```text
zsh: command not found: awf
```

Your shell, not awf, prints this: `awf` isn't on your PATH. `bun add -g agentswf` puts it in
`~/.bun/bin`, which must be on your PATH: [Install](/guide/install).

### `awf needs Bun`

```text
awf: awf needs Bun {range}, and this is Bun {version}; bun upgrade installs a newer one
```

Every `awf` command prints this, and does nothing else, on a Bun too old for it. Run
`bun upgrade`.

### `workflow file not found`

```text
awf: load: workflow file not found: /work/app/review.ts
awf: load: default export must be an awf.workflow/v1 workflow
```

`awf run` loads the file you name, and its default export must be what `defineWorkflow` returns.
Check the path, and that the file ends `export default defineWorkflow({ … })`:
[Workflows](/guide/workflows#a-workflow-file).

### `is not a workflow file; did you mean`

```text
awf: review-loop/20261012-2120-d300 is not a workflow file; did you mean: awf runs review-loop/20261012-2120-d300
```

You gave `awf run` a run's name where it takes a file. To see that run, use the command it
suggests; to go on with it, see [A run that stopped](#a-run-that-stopped).

### `result control plane requires POSIX Unix-domain sockets`

```text
result control plane requires POSIX Unix-domain sockets
```

A run on Windows fails with this as its reason. An agent answers awf over a Unix-domain socket,
which Windows lacks. Run awf on macOS or Linux: [Limits](/guide/limits).

## Logins

### `Claude subscription authentication is required`

```text
Claude subscription authentication is required (claude.ai login or `claude setup-token`); `claude auth status` reads as metered
```

The run opened its first claude agent, and `claude auth status` didn't show a Claude
subscription login. `reads as metered` means claude is logged in with an API key or a third-party
provider. `reads as unknown` means it isn't logged in, or `claude` isn't on your PATH.

Run `claude`, then `/login` with your Claude account. The rule, and why:
[Harnesses](/guide/harnesses#subscription-and-metered).

### `Codex subscription authentication is required`

```text
Codex subscription authentication is required (ChatGPT login); `codex login status` reads as metered
```

The same check for codex. `reads as metered` is an API-key login; `reads as unknown` is no login,
or no `codex` on your PATH. Run `codex login` and sign in with ChatGPT.

### `Cursor authentication is required`

```text
Cursor authentication is required (`cursor-agent login`); `cursor-agent status` reads as logged out
```

Run `cursor-agent login`. What each harness needs installed: [Install](/guide/install#each-harness).

### `{harness} needs a login`

```text
pi needs a login for openai-codex: run `pi`, then /login (pi said: No API key found for openai-codex.)
claude needs a login: run `claude`, then /login; a sandboxed claude's CLAUDE_CODE_OAUTH_TOKEN comes from `claude setup-token` (claude said: Not logged in · Please run /login)
```

A turn found its harness had no login, or had it refused: pi's login, which is per provider and
isn't checked up front, or a login that lapsed mid-run. The turn ends `failed` with
`outcome.login`, and every later turn on that harness fails the same way.

Run the command in the message, then continue the run ([below](#a-run-that-stopped)). A workflow
can stop as soon as it sees one, rather than fail every agent on that harness:
[What each ending means](/guide/agents#what-each-ending-means).

### `a sandboxed claude needs CLAUDE_CODE_OAUTH_TOKEN`

```text
a sandboxed claude needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`): its login lives in the keychain
a sandboxed cursor needs CURSOR_API_KEY (a Cursor API key, from its dashboard): its login lives in the keychain
```

claude and cursor keep their logins in the macOS keychain, which a sandbox can't reach, so a
sandboxed agent of theirs takes a token from the environment you run `awf` in. Run
`claude setup-token` and export what it prints as `CLAUDE_CODE_OAUTH_TOKEN`, or export a Cursor
API key as `CURSOR_API_KEY`. [Install](/guide/install#each-harness) lists each harness's needs.

## Metered claude and API keys

### `headless claude is billed per token even on a subscription login`

```text
headless claude is billed per token even on a subscription login; set metered: true to run it
```

A headless claude agent runs `claude -p`, which is metered on any login, so awf refuses to open
it without your consent. Drop `placement: "headless"` to run it in a pane, the default, which
stays on your plan; or add `metered: true` to its runtime if per-token billing is what you want.
`awf test` refuses it the same way. The refusal comes when that agent opens, which may be after
other agents have done work: [Harnesses](/guide/harnesses#subscription-and-metered).

### `subscription runtime refused metered credential environment`

```text
awf: runtime: subscription runtime refused metered credential environment: ANTHROPIC_API_KEY; the run did not start, and nothing of it is kept
```

Your environment holds a key that would move an agent to per-token billing, so `awf run` won't
start. Unset each variable it names in the shell you run `awf` from. A new run leaves nothing
behind, so the same command starts it again. On `--continue` the run's records are kept, with
this as the attempt's reason, and you continue again once the variable is unset. The rule is on
[Harnesses](/guide/harnesses#subscription-and-metered), the variables on
[Configuration](/reference/configuration#refused).

### `decision model "jev" is unavailable`

```text
decision model "jev" is unavailable: OPENROUTER_API_KEY is not set
no decision model alias "gpt"; installed: jev
```

A [decision](/guide/decisions#the-model-and-its-key) on `jev` needs `OPENROUTER_API_KEY`, in the
environment or in a `.env` in the folder you run `awf` from. A run without it starts as usual;
only asking for `jev` fails. The second message is a model name awf doesn't have: `jev` is the
one built in.

## Models and effort

### `unknown runtime alias`

```text
unknown runtime alias: opus
```

A `runtime` given as a bare string is an alias, and only `claude` and `codex` exist. To name a
model, spell the target out, `{ harness: "claude", model: "opus" }`:
[Harness and model](/guide/harnesses#harness-and-model). A model id spelled out is passed to the
harness as it is, and awf doesn't check it: one the harness doesn't know fails the agent's first
turn, with the harness's own words as its reason.

### `has no effort`

```text
claude has no effort "ultra"; its levels are low, medium, high, xhigh, max
```

Each harness names its own effort levels, and the open rejects one it doesn't list. Pick one from
the message: [Effort](/guide/harnesses#effort).

## Herdr

Pane agents, the default, run in [Herdr](https://herdr.dev). A headless agent needs none
([the words](/guide/how-it-works#the-words)).

### `herdr session list failed`

```text
herdr session list failed: {what herdr or the shell said}
```

As its first pane agent opened, the run couldn't ask Herdr for its sessions, usually because
`herdr` isn't installed or isn't on your PATH. Install Herdr 0.9.1, the version awf is built for:
[Install](/guide/install#what-you-need).

### `Herdr session {name} is not running`

```text
Herdr session review is not running, and awf starts only sessions named awf or awf-…; start it with `herdr --session review server`
```

`AWF_HERDR_SESSION` names a session that is down. awf starts a session for its panes only when
its name is `awf` or starts with `awf-`, since another may be yours. Start it with the command in
the message, or unset `AWF_HERDR_SESSION` to use `awf`.

### `is not a Herdr session name awf uses`

```text
AWF_HERDR_SESSION "My Runs" is not a Herdr session name awf uses: lowercase letters, digits and -, up to 32, not starting with -
```

Set `AWF_HERDR_SESSION` to a name that fits, such as `awf-mine`, or unset it to use `awf`.

### `Herdr session {name} did not answer`

```text
Herdr session awf did not answer within 10s; its log is under {dir}, and `herdr session attach awf` shows it
```

The session is listed as running but didn't answer. Look at its log and attach to it. If it's
stuck, `herdr session stop awf` stops it and the next run starts it again.

### `runs herdr {old}, not the {new} installed`

```text
herdr session awf runs herdr 0.9.0, not the 0.9.1 installed; restart it with herdr session stop awf once no run is using it
```

A progress line, not an error: you updated Herdr while the session kept running the old one. awf
restarts its own session when nothing runs in it; otherwise stop it yourself once your runs end.

### `Herdr never detected {harness}`

```text
Herdr never detected claude: {the last lines of its pane}
```

The harness was typed into its pane and Herdr never saw it start. The message ends with the
pane's last lines, which usually say why: a command not found, a first-run screen, an update
prompt. Run the harness once in a terminal of your own and clear whatever it asks.

### `not in a Herdr pane`

```text
not in a Herdr pane: HERDR_SOCKET_PATH is not set
```

`awf run --here` drives the session it was typed in, so it must be typed in a Herdr pane:
[Calling session](/guide/calling-session).

## An agent that never answers

An agent hands its answer back with `wfa result`. A turn that ends without one has an outcome
other than `answered`, and its `reason` is the sentence below. Your workflow sees it as
`outcome.reason`; if the workflow stops or fails on it, the run's closing lines print it.

### `agent settled without an accepted result`

```text
agent settled without an accepted result
```

The agent stopped working without sending an answer that fits the schema, even after awf nudged
it to. The turn ends `unanswered` and the agent stays open.

See what it did with `awf logs {run} --agent {key}`: often it answered in prose instead of with
`wfa result`, or its value didn't fit the schema. A prompt that says what to send, a smaller
schema, or a nudge in your own words helps ([Nudges](/guide/deadlines#your-own-words)). To try
again, run another turn on the same agent.

### A pane agent waiting on a prompt

A pane agent that Herdr sees stuck on a question only a person can answer, such as a permission
prompt, ends its turn `blocked`. Its line in the run's progress ends with where to look:

```text
 · herdr session attach awf
```

Attach and answer it, or stop the run. [What each ending means](/guide/agents#what-each-ending-means).

### `operation deadline exceeded`

```text
operation deadline exceeded
a deadline around it passed while it waited
```

The turn's `timeoutMs`, or a deadline around it such as the run's `--timeout`, passed first. The
turn ends `timed-out`, and that closes the agent. Without a deadline, an agent that keeps working
is never cut off, since a nudge only reaches one that stopped: give its `run` a `timeoutMs`, or
the run a `--timeout` ([Deadlines](/guide/deadlines#deadlines)).

### `logical agent is closed`

```text
logical agent is closed
```

Your workflow's call rejects with this: `run`, `compact`, `set` or `fork` on an agent whose turn
failed or timed out. The "logical agent" is the one your workflow opened under its key, which awf
closed along with its session. Open a new agent under another key:
[What each ending means](/guide/agents#what-each-ending-means).

## A run that stopped

A run that didn't complete ends with the command that goes on from where it stopped, and
`awf runs {run}` prints it as its `continue:` line. A workflow that throws ends `failed`, exit
code 1, with the error's message as its reason. A run whose process died, as after a crash or a
closed laptop, shows `interrupted`. Going on is
[Runs](/guide/runs#going-on-from-a-stopped-run); what is reused and redone is
[Durability](/guide/durability).

### `exists; --continue goes on with it`

```text
awf: 20261101-0930-a1b2 exists; --continue goes on with it, or --id another id starts over
```

The `--id` you gave is taken. Add `--continue` to go on with that run, or pick another id.

### `is still running, as process {pid}`

```text
awf: attempt 2 of ABC-1 is still running, as process 48213
```

Two attempts of one run can't run at once. Wait for it, or stop it: Ctrl-C in its terminal, or
`kill 48213`, which awf takes as it takes Ctrl-C, ending its turns. Then continue.

### `completed; there is nothing to continue`

```text
awf: ABC-1 completed; there is nothing to continue
awf: ABC-1 completed; to redo from a stage, --from-stage one of:
```

A completed run has nothing left to go on with. To redo part of it, add `--from-stage` and one of
the stages listed: [Redo from a stage](/guide/runs#redo-from-a-stage).

### `no run {id} of {workflow}`

```text
awf: no run ABC-1 of ship-ticket in /work/app/.awf/runs; a run is kept under the directory it works in, which --cwd names
awf: ABC-1 is a run of ship-ticket-v2; move /work/app/.awf/runs/ship-ticket-v2/ABC-1 to /work/app/.awf/runs/ship-ticket/ABC-1 to continue it here
```

A run is kept in `.awf/runs/{workflow}/{id}` under the directory it works in. Continue from that
directory, or give the same `--cwd` or `--run-root` it was started with. The second message means
the run is kept under another workflow name, as after a change to `meta.name`: move the folder as
it says, or change the name back.

### `keeps the arguments it was started with`

```text
awf: ABC-1 keeps the arguments it was started with; a run with others is a new run (--id)
awf: ABC-1 works in /work/app, not /work/other
awf: ABC-1 runs in the sandbox it was started with; leave --sandbox out
```

A continue reuses the run's arguments, `--cwd` and `--sandbox`. Giving the same ones again is
fine; leave out any that differ, or start a new run.

## Sandboxes

What each provider needs installed is on [Install](/guide/install#sandboxes); what a spec may name
is on [Sandboxes](/guide/sandboxes#catches). A sandbox that can't open rejects
`wf.sandboxes.open`, or the agent's open, with its message.

### `docker: the sandbox image {image} is not built`

```text
docker: the sandbox image awf-agent:{hash} is not built, and every box's proxy runs on it; build it with: docker build -t awf-agent:{hash} {dir}
```

Every docker sandbox's proxy runs on awf's own image, which is built on your machine. Run the
command in the message once. The tag follows awf's Dockerfile, so an update of awf may ask for
it again.

### `docker did not answer`

```text
docker did not answer within 5s: {what docker said}
```

The docker daemon isn't running. Start it, or name `srt: {}` in the spec to use srt instead:
[srt or docker](/guide/sandboxes#srt-or-docker).

### `docker: the image {image} is not here`

```text
docker: the image my-agent:1 is not here; pull it first: docker pull my-agent:1
```

The image your spec names with `docker: { image }` isn't on this machine. Pull or build it first.

### `docker: the image lacks {command}`

```text
docker: the image lacks claude
docker: the image lacks herdr or zsh for panes
```

An image you name must hold the harness's command, `bun` and `node`, and for pane agents `herdr`
and `zsh`. Install them in it, or leave `image` out to use awf's.

### `the sandbox's Herdr is {version}`

```text
the sandbox's Herdr is herdr 0.9.0, and this adapter drives herdr 0.9.1
```

A docker sandbox's panes run in a Herdr inside the box, which must be the version awf drives.
Install Herdr 0.9.1 in your image.

### `docker: a box cannot reach host sockets`

```text
docker: a box cannot reach host sockets (/tmp/app.sock); use srt
docker: /var/run holds docker's socket
```

A container can't reach a socket on your machine, so a spec with `sockets` needs srt. And no path
a box mounts may hold docker's own socket, which would let an agent start containers with your
machine mounted: name a narrower path.

### `sandbox provider is not installed`

```text
the docker sandbox provider is not installed
no sandbox provider is installed
```

The spec names a provider that isn't on this machine, or names none and neither srt nor docker
is. Install one: [Install](/guide/install#sandboxes). A provider that is installed but can't be
used says why instead: `the srt sandbox provider is not usable: {why}`.

### `is not on PATH`

```text
claude is not on PATH
claude on PATH is a mise shim; put its install on PATH
```

A sandboxed agent's harness must be on your PATH, and found there as itself: a version manager's
shim (mise, asdf, volta, rtx) can't run inside the sandbox. Put the directory of the real install
on your PATH ahead of the shims.

### `a sandboxed pi needs its model as provider/model`

```text
a sandboxed pi needs its model as provider/model, such as openai-codex/…
```

A sandboxed pi agent names its provider in its model, as `{provider}/{model}`, so awf knows which
domain the sandbox must allow.

### `srt does not confine on this machine`

```text
srt does not confine on this machine: its probe read a denied file or domain
```

On its first use in a run, awf checks that srt really holds a process in, and it didn't, so the
sandbox doesn't open. On Linux, srt needs bubblewrap installed. Until srt confines, name
`docker: {}` in the spec.

### `would expose ~`

```text
sandbox write /Users/you would expose ~
sandbox cwd /Users/you would expose ~
```

A sandbox never reaches your home directory itself, your credentials or harness state, or awf's
own directories. Name a project folder under `~` instead. A spec without `cwd` takes the run's,
so the second message means you ran `awf run` from `~`: run it from your project, or give `--cwd`.
[Sandboxes](/guide/sandboxes#catches) lists what is never allowed.

## Type errors and arguments

### `Property 'prepare' is missing in type`

```text
error TS2769: No overload matches this call.
  …
        Type 'null' is not assignable to type '{ file: string; }'.
  …
      Property 'prepare' is missing in type '{ meta: …; run(…): …; }' but required in type '{ prepare: … }'.
```

`tsc` prints this for a workflow whose `run` takes arguments but that has no `prepare`. Without
`prepare`, a workflow's arguments are `null`, which is the first line it complains about. Add a
`prepare` that builds the arguments from `argv`; its return type becomes the type `run` sees:
[Arguments](/guide/workflows#arguments-prepare).

### `this workflow takes no arguments`

```text
awf: prepare: this workflow takes no arguments, not README.md
```

The workflow has no `prepare`, so it takes no arguments, and the run was given some after `--`.
Drop them, or add a `prepare` that reads them.

## Next

- [Install](/guide/install): what each harness and sandbox needs.
- [Harnesses](/guide/harnesses): subscription and metered, models and effort.
- [Runs](/guide/runs): exit codes, and going on from a stopped run.
- [Configuration](/reference/configuration): every environment variable awf reads or refuses.
- [Security](/guide/security#what-awf-refuses): why awf refuses what it does.
- [`awf run`](/reference/awf#run) and its flags.
